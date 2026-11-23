## lumina-physics · CPU twin of lumina_wet_road.gdshader (specs/05): puddle_depth(x, z)
## returns exactly the standing-water depth the shader draws.
class_name LuminaWetRoad
extends MeshInstance3D

const TILE := 48.0
const DEFAULT_HALF_WIDTH := 7.5
const RUTS := [-2.75, -1.05, 1.05, 2.75]
const PACKETS := 24
const WAVE_LIFE := 1.8

@export_range(0.0, 1.0) var flood := 0.6
@export_range(0.0, 1.0) var wetness := 1.0
@export_range(0.0, 1.0) var rain := 0.8
## Seamless noise used for the micro relief (must be the texture assigned to the shader).
@export var relief: NoiseTexture2D

var _half_width := DEFAULT_HALF_WIDTH
var _image: Image
var _events := PackedVector4Array()
var _waves := PackedVector4Array()
var _first := 0
var _count := 0
var _clock := 0.0
var _dirty := true
var _local_material: ShaderMaterial

func _init() -> void:
	_events.resize(PACKETS)
	_waves.resize(PACKETS)

func _ready() -> void:
	if relief:
		relief.changed.connect(_refresh_image)
		_refresh_image()

func _refresh_image() -> void:
	_image = relief.get_image()

func _process(delta: float) -> void:
	if _count > 0:
		_clock += delta
		while _count > 0 and _clock - _events[_first].z >= WAVE_LIFE:
			_first = (_first + 1) % PACKETS
			_count -= 1
			_dirty = true
		if _count == 0:
			_clock = 0.0
	if not mesh or mesh.get_surface_count() == 0:
		return
	var material := get_active_material(0) as ShaderMaterial
	if material:
		if material != _local_material:
			_local_material = material.duplicate() as ShaderMaterial
			if material_override:
				material_override = _local_material
			else:
				set_surface_override_material(0, _local_material)
			material = _local_material
			if relief:
				material.set_shader_parameter("relief", relief)
			material.set_shader_parameter("use_relief", relief != null)
			_dirty = true
		var configured_width = material.get_shader_parameter("half_width")
		_half_width = maxf(0.01, float(configured_width)) if configured_width != null else DEFAULT_HALF_WIDTH
		if _count > 0 or _dirty:
			material.set_shader_parameter("wave_clock", _clock)
		if _dirty:
			material.set_shader_parameter("wave_first", _first)
			material.set_shader_parameter("wave_count", _count)
			if _count > 0:
				material.set_shader_parameter("wave_events", _events)
				material.set_shader_parameter("wave_dispersion", _waves)
			_dirty = false
		material.set_shader_parameter("flood", flood)
		material.set_shader_parameter("wetness", wetness)
		material.set_shader_parameter("rain", rain)

func surface_height(x: float, z: float) -> float:
	var crown := 0.03 * (1.0 - pow(x / _half_width, 2.0))
	var ruts := 0.0
	for c in RUTS:
		ruts -= 0.018 * exp(-pow((x - c) / 0.32, 2.0))
	var along := (fposmod(z, 170.0) - 85.0) / 9.0
	var across := (x + 3.3) / 1.5
	var pool := 0.034 * exp(-along * along) * (0.95 * exp(-across * across) + 0.5 * exp(-pow((x + 1.9) / 2.2, 2.0)))
	var micro := 0.5
	if _image:
		var size := _image.get_size()
		var u := fposmod(x / TILE, 1.0) * size.x - 0.5
		var v := fposmod(z / TILE, 1.0) * size.y - 0.5
		var ix := posmod(floori(u), size.x)
		var iz := posmod(floori(v), size.y)
		var ix1 := (ix + 1) % size.x
		var iz1 := (iz + 1) % size.y
		var a := lerpf(_image.get_pixel(ix, iz).r, _image.get_pixel(ix1, iz).r, u - floorf(u))
		var b := lerpf(_image.get_pixel(ix, iz1).r, _image.get_pixel(ix1, iz1).r, u - floorf(u))
		micro = lerpf(a, b, v - floorf(v))
	return micro * 0.03 + crown + ruts - pool

func puddle_depth(x: float, z: float) -> float:
	if absf(x) > _half_width:
		return 0.0
	var level := lerpf(-0.07, 0.006 + 0.052 * flood, smoothstep(0.0, 0.15, flood))
	return maxf(0.0, level - surface_height(x, z))

## Call on sole entry or at distance-spaced tread contacts. Inputs use metres and m/s.
func disturb_puddle(point: Vector3, width: float, speed: float) -> void:
	var depth := puddle_depth(point.x, point.z)
	if width <= 0.0 or speed <= 0.04 or depth <= 0.0004:
		return
	if point.y > global_position.y + surface_height(point.x, point.z) + depth + 0.001:
		return
	var wavelength := clampf(width * 1.55, 0.045, 0.36)
	var k := TAU / wavelength
	var d := minf(depth, 0.4)
	var h := tanh(k * d)
	var term := 9.81 * k + 0.000072 * k * k * k
	var omega := sqrt(term * h)
	var group := ((9.81 + 0.000216 * k * k) * h + term * d * (1.0 - h * h)) / (2.0 * omega)
	var amplitude := minf(depth * 0.36, minf(0.17 / k, speed * width * 0.055))
	var slot := (_first + _count) % PACKETS
	if _count == PACKETS:
		_first = (_first + 1) % PACKETS
	else:
		_count += 1
	_events[slot] = Vector4(point.x, point.z, _clock, amplitude)
	_waves[slot] = Vector4(k, omega, group, wavelength)
	_dirty = true
