class_name LuminaRope
extends MeshInstance3D
## Verlet rope / cable / power line between two nodes (spec 10).
##
## Same solver as `LuminaCloth` with one row: distance + bend constraints, cross-flow
## wind drag on a cylinder, gravity sag set by `slack`. Drawn as a line strip; swap in a
## tube mesh for thick mooring lines.

@export var from_node: NodePath
@export var to_node: NodePath
@export var segments := 20
## Rope length divided by the straight-line distance (1.02 taut cable, 1.3 slack line).
@export var slack := 1.04
@export var wind := Vector3(8.0, 0.0, 2.0)
@export var drag := 1.1
@export var damping := 0.45
@export_range(0.0, 1.0) var bend := 0.35
@export var free_end := false
@export var iterations := 6
@export var ground_y := -1.0e5

var _pos := PackedVector3Array()
var _prev := PackedVector3Array()
var _segment := 1.0


func _ready() -> void:
	rebuild()


func rebuild() -> void:
	var a := (get_node(from_node) as Node3D).global_position
	var b := (get_node(to_node) as Node3D).global_position
	var count := segments + 1
	var span := a.distance_to(b)
	_segment = span * slack / float(segments)
	# Parabola with the arc length of the slack rope (first-order catenary).
	var sag := span * sqrt(maxf(0.0, 3.0 * (slack - 1.0) / 8.0))
	_pos.resize(count)
	_prev.resize(count)
	for i in count:
		var t := float(i) / float(segments)
		var p := a.lerp(b, t)
		p.y -= sag * 4.0 * t * (1.0 - t)
		_pos[i] = p
		_prev[i] = p


func _physics_process(delta: float) -> void:
	if _pos.is_empty() or delta <= 0.0:
		return
	var h := minf(delta, 1.0 / 30.0)
	var count := _pos.size()
	var keep := maxf(0.0, 1.0 - damping * h)
	for i in count:
		var pinned := i == 0 or (i == count - 1 and not free_end)
		if pinned:
			continue
		var p := _pos[i]
		var tangent := _pos[mini(i + 1, count - 1)] - _pos[maxi(i - 1, 0)]
		var velocity := (p - _prev[i]) / h
		var rel := wind - velocity
		# Only the cross-flow component loads a cable.
		var cross_flow := rel - tangent * (tangent.dot(rel) / maxf(tangent.length_squared(), 1.0e-8))
		var force := cross_flow * drag + Vector3(0.0, -9.81, 0.0)
		_prev[i] = p
		_pos[i] = p + velocity * h * keep + force * h * h
	_pos[0] = (get_node(from_node) as Node3D).global_position
	if not free_end:
		_pos[count - 1] = (get_node(to_node) as Node3D).global_position
	for _k in iterations:
		for i in count - 1:
			_solve(i, i + 1, _segment, 0.95)
		if bend > 0.0:
			for i in count - 2:
				_solve(i, i + 2, _segment * 2.0, 0.95 * bend)
		for i in count:
			_pos[i].y = maxf(_pos[i].y, ground_y)
	_draw()


func _solve(i: int, j: int, rest_length: float, weight: float) -> void:
	var count := _pos.size()
	var wi := 0.0 if i == 0 or (i == count - 1 and not free_end) else 1.0
	var wj := 0.0 if j == 0 or (j == count - 1 and not free_end) else 1.0
	if wi + wj == 0.0:
		return
	var delta := _pos[j] - _pos[i]
	var length := delta.length()
	if length < 1.0e-9:
		return
	var k := (length - rest_length) / length * weight / (wi + wj)
	_pos[i] += delta * (k * wi)
	_pos[j] -= delta * (k * wj)


## World position along the rope, t in 0..1.
func point_at(t: float) -> Vector3:
	var f := clampf(t, 0.0, 1.0) * float(_pos.size() - 1)
	var i := mini(int(f), _pos.size() - 2)
	return _pos[i].lerp(_pos[i + 1], f - float(i))


func _draw() -> void:
	var immediate := mesh as ImmediateMesh
	if immediate == null:
		immediate = ImmediateMesh.new()
		mesh = immediate
	immediate.clear_surfaces()
	immediate.surface_begin(Mesh.PRIMITIVE_LINE_STRIP)
	var inverse := global_transform.affine_inverse()
	for p in _pos:
		immediate.surface_add_vertex(inverse * p)
	immediate.surface_end()
