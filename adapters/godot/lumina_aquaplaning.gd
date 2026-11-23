## lumina-physics · aquaplaning for VehicleBody3D (specs/05).
## Scales each VehicleWheel3D's friction by the standing-water depth under its contact
## patch and the NASA hydroplaning speed, and applies water drag at the patch.
class_name LuminaAquaplaning
extends VehicleBody3D

@export var road: LuminaWetRoad
@export var tire_pressure_kpa := 220.0
@export var tread_depth := 0.0028
@export var dry_grip := 10.5
@export var wet_grip := 7.2

## Mean hydroplaning factor of all wheels (0..1) – drive HUDs, spray and audio from it.
var hydroplaning := 0.0
var wheel_depth: Array[float] = []

static func hydroplaning_speed(pressure_kpa: float) -> float:
	return 6.35 * sqrt(pressure_kpa) / 3.6   # m/s

func _physics_process(_delta: float) -> void:
	if road == null:
		return
	var vp := hydroplaning_speed(tire_pressure_kpa)
	var speed := linear_velocity.length()
	var sum := 0.0
	wheel_depth.clear()
	for child in get_children():
		var wheel := child as VehicleWheel3D
		if wheel == null:
			continue
		var contact := wheel.global_position - global_transform.basis.y * wheel.wheel_radius
		var depth := road.puddle_depth(contact.x, contact.z) if wheel.is_in_contact() else 0.0
		wheel_depth.append(depth)
		var depth_factor := smoothstep(tread_depth, tread_depth + 0.0095, depth)
		var hydro := depth_factor * smoothstep(0.74 * vp, 1.08 * vp, speed)
		var viscous := 0.22 * depth_factor * smoothstep(0.3 * vp, 0.74 * vp, speed)
		wheel.wheel_friction_slip = lerpf(dry_grip, wet_grip, road.wetness) * maxf(0.05, 1.0 - 0.95 * hydro - viscous)
		sum += hydro
		if depth > 0.0005 and speed > 1.0:
			# Momentum lost to displaced water; unequal depth left/right yaws the car.
			var drag := 0.5 * 1000.0 * 0.85 * (0.22 * minf(depth, 0.05)) * speed * speed
			apply_force(-linear_velocity / speed * drag, contact - global_position)
	hydroplaning = sum / maxf(1.0, wheel_depth.size())
