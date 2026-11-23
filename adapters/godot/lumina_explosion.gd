## lumina-physics · context-aware explosion archetypes (specs/08).
## Expects child GPUParticles3D nodes named Fire, Smoke, Sparks, Spray, Mist (one-shot,
## emitting = false) and an OmniLight3D named Flash. Call detonate("c4", 1.0).
class_name LuminaExplosion
extends Node3D

signal explosion(kind: String, position: Vector3, intensity: float)
signal camera_trauma(amount: float)
## Emitted when the blast is near water: (position, radius, impulse_m, foam).
signal water_impulse(position: Vector3, radius: float, impulse: float, foam: float)


## Per-archetype tuning at yield 1 (see the table in specs/08).
const ARCHETYPES := {
	"petrol":     { "flash": Color(1.0, 0.54, 0.23), "flash_energy": 55.0,  "flash_decay": 1.5,  "blast_radius": 15.0, "impulse": 900.0,  "trauma": 0.6,  "water": -0.55, "pools": ["Fire", "Smoke", "Sparks"] },
	"c4":         { "flash": Color(1.0, 0.96, 0.89), "flash_energy": 450.0, "flash_decay": 16.0, "blast_radius": 32.0, "impulse": 5200.0, "trauma": 1.6,  "water": -1.2,  "pools": ["Fire", "Smoke", "Sparks", "Mist"] },
	"water":      { "flash": Color(0.81, 0.91, 1.0), "flash_energy": 4.0,   "flash_decay": 14.0, "blast_radius": 34.0, "impulse": 3400.0, "trauma": 0.85, "water": -2.0,  "pools": ["Spray", "Mist"] },
	"electrical": { "flash": Color(0.61, 0.77, 1.0), "flash_energy": 90.0,  "flash_decay": 28.0, "blast_radius": 7.0,  "impulse": 240.0,  "trauma": 0.32, "water": 0.0,   "pools": ["Sparks", "Smoke"] },
}

@export var water_level := 0.0
var _flash_energy := 0.0
var _flash_decay := 1.0

func detonate(kind: String, yield_scale := 1.0) -> void:
	var a: Dictionary = ARCHETYPES.get(kind, ARCHETYPES["petrol"])
	for pool_name in a["pools"]:
		var pool := get_node_or_null(pool_name) as GPUParticles3D
		if pool:
			pool.scale = Vector3.ONE * yield_scale
			pool.restart()
			pool.emitting = true
	var light := get_node_or_null("Flash") as OmniLight3D
	if light:
		light.light_color = a["flash"]
		_flash_energy = a["flash_energy"] * yield_scale * yield_scale
		_flash_decay = a["flash_decay"]
		light.omni_range = a["blast_radius"] * 3.0 * yield_scale
	_blast(a["blast_radius"] * yield_scale, a["impulse"] * yield_scale, 1.2 if kind == "water" else 0.35)
	var camera := get_viewport().get_camera_3d()
	var distance := global_position.distance_to(camera.global_position) if camera else 0.0
	camera_trauma.emit(pow(minf(1.0, 38.0 * a["trauma"] * yield_scale / (distance + 12.0)), 1.25))
	explosion.emit(kind, global_position, minf(1.0, yield_scale))
	if a["water"] != 0.0 and global_position.y - water_level < 5.0:
		water_impulse.emit(global_position, 6.5 * yield_scale, a["water"] * yield_scale, 8.0)

## Radial impulse on nearby rigid bodies (inverse-square-ish falloff, slight upward bias).
func _blast(radius: float, impulse: float, up_bias: float) -> void:
	var shape := SphereShape3D.new()
	shape.radius = radius
	var query := PhysicsShapeQueryParameters3D.new()
	query.shape = shape
	query.transform = Transform3D(Basis.IDENTITY, global_position)
	for hit in get_world_3d().direct_space_state.intersect_shape(query, 64):
		var body := hit["collider"] as RigidBody3D
		if body == null:
			continue
		var offset := body.global_position - global_position
		var dist := maxf(offset.length(), 0.25)
		var fall := pow(1.0 - minf(dist / radius, 1.0), 2.0)
		var dir := (offset / dist + Vector3.UP * up_bias).normalized()
		body.apply_central_impulse(dir * impulse * fall * minf(1.0, pow(body.mass, 1.0 / 3.0) * 0.6 + 0.2))
		body.apply_torque_impulse(Vector3(randf() - 0.5, randf() - 0.5, randf() - 0.5) * impulse * fall * 0.04)

func _process(delta: float) -> void:
	var light := get_node_or_null("Flash") as OmniLight3D
	if light:
		_flash_energy *= exp(-_flash_decay * delta)
		light.light_energy = _flash_energy
