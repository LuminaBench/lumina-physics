## lumina-physics · parametric breaking tsunami (specs/03). Mirrors the shader profile on
## the CPU so buoyancy lifts and throws vessels with the visible wave.
class_name LuminaTsunami
extends Resource

@export var height := 24.0
@export var width := 46.0
@export var direction := 0.0      ## radians
@export var speed := 19.0
@export_range(0.0, 1.0) var breaking := 0.85

var front := -1.0e5
var amplitude := 0.0
var running := false
var _target := 0.0

func launch(target: Vector3, distance: float) -> void:
	front = target.x * cos(direction) + target.z * sin(direction) - distance
	running = true
	_target = 1.0

func stop() -> void:
	_target = 0.0

func update(delta: float, material: ShaderMaterial = null) -> void:
	amplitude = lerpf(amplitude, _target, minf(1.0, delta * 1.6))
	if running:
		front += speed * delta
	if material:
		material.set_shader_parameter("tsunami_height", height * amplitude)
		material.set_shader_parameter("tsunami_width", width)
		material.set_shader_parameter("tsunami_direction", Vector2(cos(direction), sin(direction)))
		material.set_shader_parameter("tsunami_front", front)
		material.set_shader_parameter("tsunami_breaking", breaking)

func _profile(x: float, z: float) -> Vector2:  # (elevation, crest)
	var h0 := height * amplitude
	if h0 < 0.001:
		return Vector2.ZERO
	var dx := cos(direction)
	var dz := sin(direction)
	var cross := -x * dz + z * dx
	var s := x * dx + z * dz - front + width * (0.12 * sin(cross * 0.011 + 1.3) + 0.06 * sin(cross * 0.037 + 0.4))
	var h := h0 * (1.0 + 0.12 * sin(cross * 0.017 + 0.5))
	var wf := width * lerpf(0.6, 0.24, breaking)
	var wb := width * 1.6
	var c := cosh(clampf(s / (wf if s > 0.0 else wb), -20.0, 20.0))
	var crest := 1.0 / (c * c)
	var bore := 0.0
	if s < 0.0:
		bore = 0.3 * (1.0 - smoothstep(-2.5 * wb, 0.4 * wb, s)) * exp(s / (12.0 * width))
	var tr := (s - 2.4 * wf) / (1.6 * wf)
	return Vector2(h * (maxf(crest, bore) - 0.1 * exp(-tr * tr)), crest)

func height_at(x: float, z: float) -> float:
	return _profile(x, z).x

## Horizontal water velocity under the wave (solitary-wave theory).
func flow_at(x: float, z: float, depth := 40.0) -> Vector3:
	var p := _profile(x, z)
	var d := clampf(depth, 2.0, 40.0)
	var eta := maxf(p.x, 0.0)
	var u := minf(speed, speed * eta / (d + eta) + speed * breaking * p.y * p.y * 0.8)
	return Vector3(cos(direction) * u, 0.0, sin(direction) * u)
