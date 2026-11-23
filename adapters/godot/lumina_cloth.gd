class_name LuminaCloth
extends MeshInstance3D
## Verlet cloth for flags, banners, sails and canopies (spec 10).
##
## A line-for-line port of the reference CPU solver (`modules/cloth/cpu.ts`): a grid of
## particles, position-based structural / shear / bend constraints, per-particle
## aerodynamic load along the surface normal, travelling-wave flutter, long-range
## tethers that stop the cloth stretching off its pins, sphere colliders and a ground
## plane. Attach it to a MeshInstance3D; the node's transform is the piece's frame
## (pins and tether anchors follow it).

enum Hang { HOIST, TOP_EDGE, TOP_CORNERS, FREE }

const WorldFields = preload("lumina_world_bus.gd")

@export var cols := 28
@export var rows := 18
@export var size := Vector2(2.4, 1.5)
@export var hang := Hang.HOIST
## Wind velocity in m/s. Set it from your weather system every frame.
@export var wind := Vector3(8.0, 0.0, 2.0)
## Optional override. Otherwise use an ancestor world bus, then fall back to wind above.
@export var world_fields: WorldFields
@export_range(0.0, 1.0) var stiffness := 0.92
@export_range(0.0, 1.0) var bend := 0.12
@export var drag_normal := 6.5
@export var drag_tangent := 0.35
@export var gravity_scale := 0.55
@export var damping := 0.25
@export_range(0.0, 2.0) var flutter := 1.0
## Ram-air inflation for parachutes (0 = off).
@export var inflate := 0.0
@export var substeps := 2
@export var iterations := 5
@export var ground_y := -1.0e5
## Sphere colliders as Vector4(x, y, z, radius) in world space.
@export var colliders: Array[Vector4] = []

var _pos := PackedVector3Array()
var _prev := PackedVector3Array()
var _rest := PackedVector3Array()
var _inv_mass := PackedFloat32Array()
var _tether_anchor := PackedVector3Array()
var _tether_length := PackedFloat32Array()
var _blasts: Array[Dictionary] = []
var _time := 0.0


func _ready() -> void:
	var ancestor := get_parent()
	while not world_fields and ancestor:
		world_fields = ancestor as WorldFields
		ancestor = ancestor.get_parent()
	rebuild()


## Recreate the particle grid (call after changing cols / rows / size / hang).
func rebuild() -> void:
	var count := cols * rows
	_pos.resize(count)
	_prev.resize(count)
	_rest.resize(count)
	_inv_mass.resize(count)
	_tether_anchor.resize(count)
	_tether_length.resize(count)
	var dx := size.x / float(cols - 1)
	var dy := size.y / float(rows - 1)
	for iy in rows:
		for ix in cols:
			var i := iy * cols + ix
			var local := Vector3(ix * dx, -iy * dy, 0.0)
			if hang != Hang.HOIST:
				local.x -= size.x * 0.5
			_rest[i] = local
			var pinned := false
			match hang:
				Hang.HOIST:
					pinned = ix == 0
					_tether_anchor[i] = Vector3(0.0, -iy * dy, 0.0)
					_tether_length[i] = ix * dx * 1.03
				Hang.TOP_EDGE:
					pinned = iy == 0
					_tether_anchor[i] = Vector3(local.x, 0.0, 0.0)
					_tether_length[i] = iy * dy * 1.03
				Hang.TOP_CORNERS:
					pinned = iy == 0 and (ix == 0 or ix == cols - 1)
					_tether_anchor[i] = Vector3(local.x, 0.0, 0.0)
					_tether_length[i] = iy * dy * 1.03 + size.x * 0.06
				Hang.FREE:
					_tether_length[i] = -1.0
			if pinned:
				_tether_length[i] = -1.0
			_inv_mass[i] = 0.0 if pinned else 1.0
			_pos[i] = global_transform * local
			_prev[i] = _pos[i]


## A transient pressure front (explosion, sonic boom, rotor wash).
func add_blast(origin: Vector3, strength: float, radius: float, duration := 1.2) -> void:
	_blasts.append({"origin": origin, "strength": strength, "radius": radius, "age": 0.0, "duration": duration})


func _wind_at(p: Vector3) -> Vector3:
	var air := world_fields.wind_at(p) if world_fields else wind
	for b in _blasts:
		var k: float = b.age / b.duration
		var radius: float = b.radius * (0.35 + 0.65 * k)
		var delta: Vector3 = p - b.origin
		var dist := delta.length() + 0.001
		var fall := 1.0 - minf(1.0, dist / radius)
		air += delta / dist * (b.strength * (1.0 - k) * (1.0 - k) * fall * fall)
	return air


func _physics_process(delta: float) -> void:
	if delta <= 0.0 or _pos.is_empty():
		return
	_time += delta
	for i in range(_blasts.size() - 1, -1, -1):
		var blast := _blasts[i]
		blast.age += delta
		if blast.age >= blast.duration:
			_blasts.remove_at(i)
	var h := minf(delta, 1.0 / 30.0) / float(substeps)
	for _s in substeps:
		_integrate(h)
		for _k in iterations:
			_relax()
	_upload()


func _integrate(h: float) -> void:
	var xf := global_transform
	var keep := maxf(0.0, 1.0 - damping * h)
	for iy in rows:
		for ix in cols:
			var i := iy * cols + ix
			if _inv_mass[i] == 0.0:
				_prev[i] = _pos[i]
				_pos[i] = xf * _rest[i]
				continue
			var p := _pos[i]
			var left := _pos[iy * cols + maxi(ix - 1, 0)]
			var right := _pos[iy * cols + mini(ix + 1, cols - 1)]
			var up := _pos[maxi(iy - 1, 0) * cols + ix]
			var down := _pos[mini(iy + 1, rows - 1) * cols + ix]
			var n := (right - left).cross(down - up)
			var velocity := (p - _prev[i]) / h
			var air := _wind_at(p)
			# Travelling-wave turbulence: steady wind sheds vortices that run down the cloth.
			var speed := Vector2(air.x, air.z).length()
			if speed > 0.01 and flutter > 0.0:
				var along := (p.x * air.x + p.z * air.z) / speed
				var wave := (sin(along * 3.1 - _time * speed * 1.3 + p.y * 1.7) * 0.34 + sin(along * 7.3 - _time * speed * 2.9 - p.y * 2.3) * 0.2) * speed * flutter
				air += Vector3(-air.z / speed * wave, wave * 0.35, air.x / speed * wave)
			var rel := air - velocity
			var force := rel * drag_tangent
			var n2 := n.length_squared()
			if n2 > 1.0e-8:
				force += n * (n.dot(rel) / n2 * drag_normal)
				if inflate > 0.0 and rel.y > 0.0:
					var side := 1.0 if n.dot(p - xf.origin) >= 0.0 else -1.0
					force += n / sqrt(n2) * (side * rel.y * inflate)
			force.y -= 9.81 * gravity_scale
			_prev[i] = p
			_pos[i] = p + velocity * h * keep + force * h * h


func _solve(i: int, j: int, rest_length: float, weight: float) -> void:
	var wi := _inv_mass[i]
	var wj := _inv_mass[j]
	var wsum := wi + wj
	if wsum == 0.0:
		return
	var delta := _pos[j] - _pos[i]
	var length := delta.length()
	if length < 1.0e-9:
		return
	var k := (length - rest_length) / length * weight / wsum
	_pos[i] += delta * (k * wi)
	_pos[j] -= delta * (k * wj)


func _relax() -> void:
	var xf := global_transform
	var dx := size.x / float(cols - 1)
	var dy := size.y / float(rows - 1)
	var diagonal := sqrt(dx * dx + dy * dy)
	for iy in rows:
		for ix in cols:
			var i := iy * cols + ix
			if ix + 1 < cols:
				_solve(i, i + 1, dx, stiffness)
			if iy + 1 < rows:
				_solve(i, i + cols, dy, stiffness)
			if ix + 1 < cols and iy + 1 < rows:
				_solve(i, i + cols + 1, diagonal, stiffness * 0.6)
				_solve(i + 1, i + cols, diagonal, stiffness * 0.6)
			if bend > 0.0:
				if ix + 2 < cols:
					_solve(i, i + 2, dx * 2.0, stiffness * bend)
				if iy + 2 < rows:
					_solve(i, i + cols * 2, dy * 2.0, stiffness * bend)
	for i in _pos.size():
		if _inv_mass[i] == 0.0:
			continue
		var p := _pos[i]
		if _tether_length[i] >= 0.0:
			var anchor := xf * _tether_anchor[i]
			var d := p - anchor
			var length := d.length()
			if length > _tether_length[i]:
				p = anchor + d * (_tether_length[i] / length)
		for c in colliders:
			var centre := Vector3(c.x, c.y, c.z)
			var d2 := p - centre
			var l2 := d2.length()
			if l2 < c.w and l2 > 1.0e-6:
				p = centre + d2 * (c.w / l2)
		p.y = maxf(p.y, ground_y)
		_pos[i] = p


## World position of a grid point (gameplay queries, attaching objects to the cloth).
func point(ix: int, iy: int) -> Vector3:
	return _pos[iy * cols + ix]


func _upload() -> void:
	var inverse := global_transform.affine_inverse()
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	vertices.resize(_pos.size())
	normals.resize(_pos.size())
	uvs.resize(_pos.size())
	for iy in rows:
		for ix in cols:
			var i := iy * cols + ix
			vertices[i] = inverse * _pos[i]
			var left := _pos[iy * cols + maxi(ix - 1, 0)]
			var right := _pos[iy * cols + mini(ix + 1, cols - 1)]
			var up := _pos[maxi(iy - 1, 0) * cols + ix]
			var down := _pos[mini(iy + 1, rows - 1) * cols + ix]
			normals[i] = (inverse.basis * (right - left).cross(down - up)).normalized()
			uvs[i] = Vector2(float(ix) / float(cols - 1), float(iy) / float(rows - 1))
	for iy in rows - 1:
		for ix in cols - 1:
			var a := iy * cols + ix
			indices.append_array(PackedInt32Array([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1]))
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_INDEX] = indices
	var array_mesh := mesh as ArrayMesh
	if array_mesh == null:
		array_mesh = ArrayMesh.new()
		mesh = array_mesh
	var material := array_mesh.surface_get_material(0) if array_mesh.get_surface_count() > 0 else null
	array_mesh.clear_surfaces()
	array_mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	if material != null:
		array_mesh.surface_set_material(0, material)
