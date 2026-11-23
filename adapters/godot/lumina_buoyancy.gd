## lumina-physics · multi-point buoyancy + hydrodynamic drag (specs/04).
## Attach to a RigidBody3D. Assign the same LuminaWaveSpectrum the ocean material uses.
class_name LuminaBuoyancy
extends RigidBody3D

const WATER_DENSITY := 1025.0

@export var spectrum: LuminaWaveSpectrum
@export var tsunami: LuminaTsunami
## Sample points in body space (e.g. four along each float / hull side).
@export var points: Array[Vector3] = [Vector3(-1, 0, -2), Vector3(1, 0, -2), Vector3(-1, 0, 2), Vector3(1, 0, 2)]
## Total displaced volume when fully submerged (m³).
@export var volume := 6.4
@export var draft := 0.75
@export var linear_drag := 60.0
@export var quadratic_drag := 18.0
@export var heave_damping := 2600.0
@export var keel := 6.0
@export var water_level := 0.0

var submersion := 0.0
var _time := 0.0

func water_height(x: float, z: float) -> float:
	var h := water_level
	if spectrum:
		h += spectrum.height_at(x, z, _time)
	if tsunami:
		h += tsunami.height_at(x, z)
	return h

func _physics_process(delta: float) -> void:
	_time += delta
	if points.is_empty():
		return
	var per_point := volume / points.size()
	var right := global_transform.basis.x
	var total := 0.0
	for local in points:
		var p := global_transform * local
		var depth := water_height(p.x, p.z) - p.y
		var sub := clampf(depth / draft + 0.5, 0.0, 1.0)
		total += sub
		if sub <= 0.0:
			continue
		var offset := p - global_position
		var flow := tsunami.flow_at(p.x, p.z) if tsunami else Vector3.ZERO
		var v := linear_velocity + angular_velocity.cross(offset) - flow
		var k := (linear_drag + quadratic_drag * v.length()) * sub
		var force := Vector3(-v.x * k, WATER_DENSITY * 9.81 * per_point * sub, -v.z * k)
		force.y -= v.y * (heave_damping * sub + quadratic_drag * absf(v.y))
		force -= right * (v.dot(right) * k * keel)   # keel: resist sideways slip
		apply_force(force, offset)
	submersion = total / points.size()
