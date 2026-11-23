class_name LuminaFracture
extends StaticBody3D
## Pre-fractured destructible box: concrete, glass, wood or brick (spec 11).
##
## Port of `modules/destruction`: the box is cut into convex Voronoi cells (every cell is
## the intersection of the box with the bisector half-spaces of its site), so each chunk
## is a valid convex collider and knows its neighbours. `impact()` loosens the chunks
## near a hit into RigidBody3D pieces with mass = volume x density; a flood fill from the
## anchored chunks then drops whatever is no longer held up.

signal broke(count: int, at: Vector3)

enum Kind { CONCRETE, GLASS, WOOD, BRICK }

const DENSITY := {Kind.CONCRETE: 2400.0, Kind.GLASS: 2500.0, Kind.WOOD: 620.0, Kind.BRICK: 1900.0}
## Joules per cubic metre of material turned into loose chunks.
const FRACTURE_ENERGY := {Kind.CONCRETE: 240000.0, Kind.GLASS: 2500.0, Kind.WOOD: 60000.0, Kind.BRICK: 110000.0}


@export var kind := Kind.CONCRETE
@export var size := Vector3(4.0, 2.4, 0.35)
@export var pieces := 28
@export var seed_value := 11
@export var toughness := 1.0
@export var material: Material

## Each cell: { "faces": Array[PackedVector3Array], "normals": Array[Vector3],
##              "owners": PackedInt32Array, "centroid": Vector3, "volume": float,
##              "neighbours": PackedInt32Array, "state": int, "anchored": bool, "node": Node3D }
var cells: Array[Dictionary] = []
var broken := 0


func _ready() -> void:
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = size
	shape.shape = box
	shape.name = "Intact"
	add_child(shape)
	fracture(Vector3.ZERO)


# ---- convex geometry ------------------------------------------------------------

static func box_faces(extent: Vector3) -> Dictionary:
	var h := extent * 0.5
	var faces: Array[PackedVector3Array] = []
	var normals: Array[Vector3] = []
	var quads := [
		[Vector3(1, 0, 0), Vector3(h.x, -h.y, -h.z), Vector3(h.x, h.y, -h.z), Vector3(h.x, h.y, h.z), Vector3(h.x, -h.y, h.z)],
		[Vector3(-1, 0, 0), Vector3(-h.x, -h.y, h.z), Vector3(-h.x, h.y, h.z), Vector3(-h.x, h.y, -h.z), Vector3(-h.x, -h.y, -h.z)],
		[Vector3(0, 1, 0), Vector3(-h.x, h.y, -h.z), Vector3(-h.x, h.y, h.z), Vector3(h.x, h.y, h.z), Vector3(h.x, h.y, -h.z)],
		[Vector3(0, -1, 0), Vector3(-h.x, -h.y, h.z), Vector3(-h.x, -h.y, -h.z), Vector3(h.x, -h.y, -h.z), Vector3(h.x, -h.y, h.z)],
		[Vector3(0, 0, 1), Vector3(-h.x, -h.y, h.z), Vector3(h.x, -h.y, h.z), Vector3(h.x, h.y, h.z), Vector3(-h.x, h.y, h.z)],
		[Vector3(0, 0, -1), Vector3(h.x, -h.y, -h.z), Vector3(-h.x, -h.y, -h.z), Vector3(-h.x, h.y, -h.z), Vector3(h.x, h.y, -h.z)],
	]
	for q in quads:
		normals.append(q[0])
		faces.append(PackedVector3Array([q[1], q[2], q[3], q[4]]))
	var owners := PackedInt32Array()
	owners.resize(6)
	owners.fill(-1)
	return {"faces": faces, "normals": normals, "owners": owners}


## Keep the part of a convex solid on the negative side of the plane n.x = d; the cut is
## closed with a face owned by `tag`.
static func clip(solid: Dictionary, n: Vector3, d: float, tag: int) -> Dictionary:
	var faces: Array[PackedVector3Array] = []
	var normals: Array[Vector3] = []
	var owners := PackedInt32Array()
	var rim := PackedVector3Array()
	for f in solid.faces.size():
		var pts: PackedVector3Array = solid.faces[f]
		var kept := PackedVector3Array()
		for i in pts.size():
			var a := pts[i]
			var b := pts[(i + 1) % pts.size()]
			var da := n.dot(a) - d
			var db := n.dot(b) - d
			if da <= 1.0e-7:
				kept.append(a)
			if (da < -1.0e-7 and db > 1.0e-7) or (da > 1.0e-7 and db < -1.0e-7):
				var p := a.lerp(b, da / (da - db))
				kept.append(p)
				rim.append(p)
		if kept.size() >= 3:
			faces.append(kept)
			normals.append(solid.normals[f])
			owners.append(solid.owners[f])
	if rim.size() >= 3:
		# The cut of a convex solid is a convex polygon: order its points by angle.
		var centre := Vector3.ZERO
		for p in rim:
			centre += p
		centre /= float(rim.size())
		var u := n.cross(Vector3(1, 0, 0) if absf(n.x) < 0.9 else Vector3(0, 1, 0)).normalized()
		var w := n.cross(u)
		var order: Array = []
		for p in rim:
			order.append([atan2((p - centre).dot(w), (p - centre).dot(u)), p])
		order.sort_custom(func(x: Array, y: Array) -> bool: return x[0] < y[0])
		var loop := PackedVector3Array()
		for entry in order:
			if loop.is_empty() or loop[loop.size() - 1].distance_squared_to(entry[1]) > 1.0e-10:
				loop.append(entry[1])
		if loop.size() >= 3:
			faces.append(loop)
			normals.append(n)
			owners.append(tag)
	return {"faces": faces, "normals": normals, "owners": owners}


static func measure(solid: Dictionary) -> Dictionary:
	var reference := Vector3.ZERO
	var count := 0
	for pts in solid.faces:
		for p in pts:
			reference += p
			count += 1
	reference /= float(maxi(count, 1))
	var centroid := Vector3.ZERO
	var volume := 0.0
	for pts in solid.faces:
		for i in range(1, pts.size() - 1):
			var a: Vector3 = pts[0] - reference
			var b: Vector3 = pts[i] - reference
			var c: Vector3 = pts[i + 1] - reference
			var v := absf(a.dot(b.cross(c))) / 6.0
			volume += v
			centroid += (pts[0] + pts[i] + pts[i + 1] + reference) * (v / 4.0)
	centroid = centroid / volume if volume > 1.0e-12 else reference
	return {"centroid": centroid, "volume": volume}


## Voronoi cells of `sites` inside a box. Material character comes from where the sites go.
func fracture(focus: Vector3) -> void:
	for cell in cells:
		if cell.has("node") and is_instance_valid(cell.node):
			cell.node.queue_free()
	cells.clear()
	broken = 0
	var rng := RandomNumberGenerator.new()
	rng.seed = seed_value
	var half := size * 0.5
	var stretch := Vector3.ONE
	var sites: Array[Vector3] = []
	match kind:
		Kind.GLASS:
			# Rings and spokes in the pane, through its full thickness: radial shards.
			var thin := 0 if size.x <= size.y and size.x <= size.z else (1 if size.y <= size.z else 2)
			var u := (thin + 1) % 3
			var w := (thin + 2) % 3
			var radius := Vector2(size[u], size[w]).length() * 0.045
			var centre := focus
			centre[thin] = 0.0
			sites.append(centre)
			var rings := maxi(2, roundi(sqrt(pieces / 5.0)))
			for r in rings:
				var spokes := roundi(5.0 + r * (pieces / float(rings) / 2.2))
				var phase := rng.randf() * TAU
				for s in spokes:
					var angle := phase + (s + (rng.randf() - 0.5) * 0.55) / float(spokes) * TAU
					var p := centre
					p[u] += cos(angle) * radius * (0.8 + rng.randf() * 0.45)
					p[w] += sin(angle) * radius * (0.8 + rng.randf() * 0.45)
					sites.append(p)
				radius *= 2.1
		Kind.WOOD:
			# Fracture in a space squashed along the grain: cells come out as long splinters.
			var grain := 0 if size.x >= size.y and size.x >= size.z else (1 if size.y >= size.z else 2)
			stretch[grain] = 0.16
			for i in pieces:
				sites.append(Vector3(rng.randf_range(-half.x, half.x), rng.randf_range(-half.y, half.y), rng.randf_range(-half.z, half.z)))
		_:
			var spread := maxf(size.x, maxf(size.y, size.z)) * 0.22
			for i in pieces:
				if i % 2 == 0:
					var p := focus + Vector3(rng.randf_range(-spread, spread), rng.randf_range(-spread, spread), rng.randf_range(-spread, spread))
					sites.append(p.clamp(-half, half))
				else:
					sites.append(Vector3(rng.randf_range(-half.x, half.x), rng.randf_range(-half.y, half.y), rng.randf_range(-half.z, half.z)))
	var box := box_faces(size * stretch)
	for i in sites.size():
		var site := sites[i] * stretch
		var solid := {"faces": box.faces.duplicate(true), "normals": box.normals.duplicate(), "owners": box.owners.duplicate()}
		for j in sites.size():
			if j == i:
				continue
			var other := sites[j] * stretch
			var dist := site.distance_to(other)
			if dist < 1.0e-6:
				continue
			var n := (other - site) / dist
			solid = clip(solid, n, n.dot(site) + dist * 0.5, j)
			if solid.faces.size() < 4:
				break
		if solid.faces.size() < 4:
			continue
		# Undo the stretch.
		for f in solid.faces.size():
			var pts: PackedVector3Array = solid.faces[f]
			for k in pts.size():
				pts[k] = pts[k] / stretch
			solid.faces[f] = pts
			solid.normals[f] = (solid.normals[f] * stretch).normalized()
		var m := measure(solid)
		if m.volume < 1.0e-9:
			continue
		solid["centroid"] = m.centroid
		solid["volume"] = m.volume
		solid["site"] = i
		solid["state"] = 0
		var held := false
		for pts in solid.faces:
			for p in pts:
				if kind == Kind.GLASS:
					held = held or absf(absf(p.x) - half.x) < 0.004 or absf(absf(p.y) - half.y) < 0.004
				elif p.y < -half.y + 0.012:
					held = true
		solid["anchored"] = held
		cells.append(solid)
	# Neighbour links by site index.
	var index_of := {}
	for c in cells.size():
		index_of[cells[c].site] = c
	for cell in cells:
		var links := PackedInt32Array()
		for owner_site in cell.owners:
			if owner_site >= 0 and index_of.has(owner_site) and not links.has(index_of[owner_site]):
				links.append(index_of[owner_site])
		cell["neighbours"] = links
	for cell in cells:
		cell["node"] = _make_visual(cell)
		add_child(cell.node)


func _chunk_mesh(cell: Dictionary) -> ArrayMesh:
	var st := SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)
	for f in cell.faces.size():
		var pts: PackedVector3Array = cell.faces[f]
		var n: Vector3 = cell.normals[f]
		if n.dot(pts[0] - cell.centroid) < 0.0:
			n = -n
		for i in range(1, pts.size() - 1):
			var tri := [pts[0], pts[i], pts[i + 1]]
			# Godot front faces wind clockwise.
			if (tri[1] - tri[0]).cross(tri[2] - tri[0]).dot(n) > 0.0:
				tri = [pts[0], pts[i + 1], pts[i]]
			for p in tri:
				st.set_normal(n)
				st.set_color(Color.WHITE if cell.owners[f] == -1 else Color(0.7, 0.7, 0.7))
				st.add_vertex(p - cell.centroid)
	return st.commit()


func _make_visual(cell: Dictionary) -> MeshInstance3D:
	var visual := MeshInstance3D.new()
	visual.mesh = _chunk_mesh(cell)
	visual.material_override = material
	visual.position = cell.centroid
	return visual


# ---- damage ---------------------------------------------------------------------

## Hit the object at a world point with `energy` joules along `direction`.
func impact(point: Vector3, direction: Vector3, energy: float) -> int:
	var local := to_local(point)
	if kind == Kind.GLASS and broken == 0:
		if energy < 60.0 * toughness:
			return 0
		fracture(local.clamp(-size * 0.5, size * 0.5))
	var volume := energy / (FRACTURE_ENERGY[kind] * toughness)
	var radius := pow(volume * 3.0 / (4.0 * PI), 1.0 / 3.0)
	if kind == Kind.GLASS:
		radius = maxf(radius * 6.0, 10.0 if energy > 400.0 * toughness else 0.35)
	var picked: Array[int] = []
	var mass := 0.0
	for i in cells.size():
		if cells[i].state == 0 and cells[i].centroid.distance_to(local) < radius:
			picked.append(i)
			mass += cells[i].volume * DENSITY[kind]
	if picked.is_empty():
		return 0
	var speed := minf(14.0, sqrt(2.0 * energy * 0.25 / maxf(1.0, mass)))
	for i in picked:
		var outward := (global_transform.basis * (cells[i].centroid - local)).normalized()
		_loosen(i, outward * speed * 0.35 + direction.normalized() * speed)
	var total := picked.size() + _collapse()
	broke.emit(total, point)
	return total


## Pressure wave: loosens what it can overcome (call from your explosion code).
func blast(centre: Vector3, radius: float, strength: float) -> int:
	var local := to_local(centre)
	if kind == Kind.GLASS and broken == 0:
		fracture(local.clamp(-size * 0.5, size * 0.5))
	var reach := radius * (1.4 if kind == Kind.GLASS else (0.42 if kind == Kind.CONCRETE else 0.6))
	var picked := 0
	for i in cells.size():
		if cells[i].state != 0:
			continue
		var fall := maxf(0.0, 1.0 - cells[i].centroid.distance_to(local) / reach)
		if fall * fall * strength / toughness > (0.02 if kind == Kind.GLASS else 0.4):
			var outward := (global_transform.basis * (cells[i].centroid - local)).normalized()
			_loosen(i, outward * 6.0 * fall)
			picked += 1
	if picked > 0:
		picked += _collapse()
		broke.emit(picked, centre)
	return picked


func _loosen(index: int, velocity: Vector3) -> void:
	var cell := cells[index]
	if cell.state != 0:
		return
	_ensure_chunk_colliders()
	if cell.has("collider") and is_instance_valid(cell.collider):
		cell.collider.queue_free()
	cell.state = 1
	broken += 1
	var body := RigidBody3D.new()
	body.mass = maxf(0.01, cell.volume * DENSITY[kind])
	body.linear_velocity = velocity
	body.angular_velocity = Vector3(randf() - 0.5, randf() - 0.5, randf() - 0.5) * 5.0
	var shape := CollisionShape3D.new()
	shape.shape = _hull(cell)
	body.add_child(shape)
	var visual: Node3D = cell.node
	var world := visual.global_transform
	remove_child(visual)
	visual.transform = Transform3D.IDENTITY
	body.add_child(visual)
	get_tree().current_scene.add_child(body)
	body.global_transform = world
	cell.node = body


func _hull(cell: Dictionary) -> ConvexPolygonShape3D:
	var points := PackedVector3Array()
	for pts in cell.faces:
		for p in pts:
			points.append(p - cell.centroid)
	var hull := ConvexPolygonShape3D.new()
	hull.points = points
	return hull


## After the first damage the single box collider is replaced by one hull per chunk.
func _ensure_chunk_colliders() -> void:
	var intact := get_node_or_null("Intact")
	if intact == null:
		return
	intact.queue_free()
	for cell in cells:
		if cell.state != 0:
			continue
		var shape := CollisionShape3D.new()
		shape.shape = _hull(cell)
		shape.position = cell.centroid
		add_child(shape)
		cell["collider"] = shape


## Drop every intact chunk that is no longer connected to an anchored one.
func _collapse() -> int:
	var supported := {}
	var queue: Array[int] = []
	for i in cells.size():
		if cells[i].state == 0 and cells[i].anchored:
			supported[i] = true
			queue.append(i)
	while not queue.is_empty():
		var i: int = queue.pop_back()
		for j in cells[i].neighbours:
			if not supported.has(j) and cells[j].state == 0:
				supported[j] = true
				queue.append(j)
	var fallen := 0
	for i in cells.size():
		if cells[i].state == 0 and not supported.has(i):
			_loosen(i, Vector3.ZERO)
			fallen += 1
	return fallen
