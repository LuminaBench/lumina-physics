## lumina-physics · JONSWAP wave bank (see specs/01-ocean-spectrum-fft.md).
## Samples the same directional spectrum the Three.js FFT uses into N Gerstner waves that
## drive BOTH the ocean shader and CPU buoyancy, so hulls ride the waves you see.
## Starter scope: for a full FFT port, implement the passes in specs/01 as compute shaders.
class_name LuminaWaveSpectrum
extends Resource

const GRAVITY := 9.81
const MAX_WAVES := 64

@export var wind_speed := 8.0           ## m/s at 10 m
@export var wind_direction := 0.4       ## radians, direction of travel (0 = +X)
@export var fetch_m := 60000.0
@export var swell_height := 0.6         ## significant height, m
@export var swell_direction := 0.8
@export var swell_period := 9.0
@export_range(0.0, 1.4) var chop := 0.9
@export_range(8, 64) var wave_count := 48
@export var seed_value := 7

## xy = unit direction, z = wavenumber k, w = amplitude (m)
var waves := PackedVector4Array()
## x = angular frequency ω, y = phase offset
var phases := PackedVector2Array()
var significant_height := 0.0

func _spread_norm(s: float) -> float:
	# Γ(s+1) / (2 √π Γ(s+½)) via Stirling-series log-gamma.
	return exp(_lgamma(s + 1.0) - _lgamma(s + 0.5)) / (2.0 * sqrt(PI))

func _lgamma(x: float) -> float:
	return (x - 0.5) * log(x) - x + 0.5 * log(TAU) + 1.0 / (12.0 * x) - 1.0 / (360.0 * x * x * x)

func _jonswap(omega: float) -> float:
	var u := maxf(wind_speed, 0.2)
	var alpha := 0.076 * pow(u * u / (fetch_m * GRAVITY), 0.22)
	var omega_p := 22.0 * pow(GRAVITY * GRAVITY / (u * fetch_m), 1.0 / 3.0)
	var sigma := 0.07 if omega <= omega_p else 0.09
	var r := exp(-pow(omega - omega_p, 2.0) / (2.0 * sigma * sigma * omega_p * omega_p))
	return alpha * GRAVITY * GRAVITY / pow(omega, 5.0) * exp(-1.25 * pow(omega_p / omega, 4.0)) * pow(3.3, r)

func rebuild() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = seed_value
	waves.clear()
	phases.clear()
	var m0 := 0.0
	var u := maxf(wind_speed, 0.2)
	var omega_p := 22.0 * pow(GRAVITY * GRAVITY / (u * fetch_m), 1.0 / 3.0)
	var swell_waves := 4 if swell_height > 0.01 else 0
	var wind_waves := clampi(wave_count, 8, MAX_WAVES) - swell_waves
	# Log-spaced frequencies from 0.6·ω_p up to short chop.
	var lo := omega_p * 0.6
	var hi := maxf(omega_p * 9.0, 7.0)
	for i in wind_waves:
		var f0 := lo * pow(hi / lo, float(i) / wind_waves)
		var f1 := lo * pow(hi / lo, float(i + 1) / wind_waves)
		var omega := sqrt(f0 * f1)
		var amplitude := sqrt(2.0 * _jonswap(omega) * (f1 - f0))
		# Direction drawn from cos^2s(θ/2): narrow at the peak, broad for short waves.
		var ratio := omega / omega_p
		var s := maxf(1.2, 14.0 * (pow(ratio, 5.0) if ratio <= 1.0 else pow(ratio, -2.5)))
		var theta := wind_direction + rng.randfn(0.0, 1.0) * sqrt(2.0 / (s + 1.0))
		var k := omega * omega / GRAVITY
		waves.append(Vector4(cos(theta), sin(theta), k, amplitude))
		phases.append(Vector2(omega, rng.randf() * TAU))
		m0 += 0.5 * amplitude * amplitude
	for i in swell_waves:
		var omega := TAU / swell_period * (1.0 + (float(i) - 1.5) * 0.045)
		var amplitude := swell_height / 4.0 * sqrt(2.0 / swell_waves)
		var theta := swell_direction + (float(i) - 1.5) * 0.05
		waves.append(Vector4(cos(theta), sin(theta), omega * omega / GRAVITY, amplitude))
		phases.append(Vector2(omega, rng.randf() * TAU))
		m0 += 0.5 * amplitude * amplitude
	significant_height = 4.0 * sqrt(m0)
	emit_changed()

## Push the wave bank into an ocean ShaderMaterial (lumina_ocean.gdshader).
func apply_to(material: ShaderMaterial, geometry_waves := 16) -> void:
	if waves.is_empty():
		rebuild()
	var padded_w := waves.duplicate()
	var padded_p := phases.duplicate()
	padded_w.resize(MAX_WAVES)
	padded_p.resize(MAX_WAVES)
	material.set_shader_parameter("waves", padded_w)
	material.set_shader_parameter("wave_phase", padded_p)
	material.set_shader_parameter("wave_count", waves.size())
	material.set_shader_parameter("geometry_waves", mini(geometry_waves, waves.size()))
	material.set_shader_parameter("chop", chop)
	material.set_shader_parameter("significant_height", significant_height)

func _displacement(x: float, z: float, t: float) -> Vector3:
	var d := Vector3.ZERO
	for i in waves.size():
		var w := waves[i]
		var p := phases[i]
		var theta := w.z * (w.x * x + w.y * z) - p.x * t + p.y
		var s := sin(theta)
		d.x -= w.x * w.w * chop * s
		d.z -= w.y * w.w * chop * s
		d.y += w.w * cos(theta)
	return d

## Water surface height at a world position (inverts the choppy displacement).
func height_at(x: float, z: float, t: float) -> float:
	var px := x
	var pz := z
	for _i in 3:
		var d := _displacement(px, pz, t)
		px = x - d.x
		pz = z - d.z
	return _displacement(px, pz, t).y
