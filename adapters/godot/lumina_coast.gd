## Game-owned coastal wave and wet-film starter. All heights are world metres.
class_name LuminaCoast
extends RefCounted


## texel contains shore phase, secondary phase, exposure gain and connected spill elevation.
static func wave_offset(texel: Vector4, depth: float, time_s: float,
		level: float, strength: float, period: float = 8.2) -> float:
	if period <= 0.0 or (depth >= 2.4 and level >= texel.w + 0.025):
		return 0.0
	var phase := TAU * time_s / period - texel.x
	var shape := 0.22 + 0.76 * sin(phase) + 0.16 * sin(2.0 * phase - 0.65)
	var envelope := strength * texel.z * (1.0 - smoothstep(1.25, 2.4, depth))
	var wave := envelope * shape * (0.87 + 0.13 * sin(texel.y - time_s * 0.19))
	var reach := smoothstep(-0.035, 0.025, level + wave - texel.w)
	return lerpf(minf(wave, -depth - 0.045), wave, reach)


static func drain_film(film: float, dt: float, drainage_seconds: float) -> float:
	return clampf(film, 0.0, 1.0) * exp(-maxf(0.0, dt) / maxf(0.001, drainage_seconds))
