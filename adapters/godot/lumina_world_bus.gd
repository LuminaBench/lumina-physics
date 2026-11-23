class_name LuminaWorldBus
extends Node3D
## Shared swept-sphere fields. Slots are stable emitter IDs. Refresh a held source
## with set_source or allow a transient to fade back to ambient conditions.

const CAPACITY := 16
@export var ambient_wind := Vector3.ZERO
@export var ambient_temperature := 18.0
@export_range(0.0, 1.0) var rainfall := 0.0
@export var materials: Array[ShaderMaterial] = []
## Dynamic bodies exposed to this field. The equivalent load scales with their mass and air slip.
@export var driven_bodies: Array[RigidBody3D] = []
var surface_wetness := 0.0
var _a := PackedVector4Array()
var _axis := PackedVector4Array()
var _wind := PackedVector4Array()
var _spin := PackedVector3Array()
var _fields := PackedVector4Array()
var _live := PackedVector4Array()
var _remaining := PackedFloat32Array()
var _duration := PackedFloat32Array()
var _count := 0

func _init() -> void:
	_a.resize(CAPACITY)
	_axis.resize(CAPACITY)
	_wind.resize(CAPACITY)
	_spin.resize(CAPACITY)
	_fields.resize(CAPACITY)
	_live.resize(CAPACITY)
	_remaining.resize(CAPACITY)
	_duration.resize(CAPACITY)

## wind is (radial, swirl, vertical, rim lift); fields are (pressure, heat, wetness, cloud cut).
func set_source(slot: int, start: Vector3, end: Vector3, radius: float, wind: Vector4, fields: Vector4, life: float, axial_swirl := false) -> void:
	if slot < 0 or slot >= CAPACITY or radius <= 0.0 or life <= 0.0:
		return
	var ab := end - start
	_a[slot] = Vector4(start.x, start.y, start.z, 1.0 / (radius * radius))
	_axis[slot] = Vector4(ab.x, ab.y, ab.z, 1.0 / maxf(0.000001, ab.length_squared()))
	_spin[slot] = ab.normalized() if axial_swirl and ab.length_squared() > 0.000001 else Vector3.UP
	_wind[slot] = wind
	_fields[slot] = fields
	_live[slot] = fields
	_remaining[slot] = life
	_duration[slot] = life
	_count = maxi(_count, slot + 1)

## Refresh from the rotor's physics tick. surface_y is the local ground or water surface.
func set_rotor(slot: int, hub: Vector3, radius: float, load_fraction: float, surface_y: float, over_water: bool) -> void:
	if radius <= 0.0:
		return
	var height := maxf(0.0, hub.y - surface_y)
	var gain := clampf(load_fraction, 0.0, 1.0) * pow(maxf(0.0, 1.0 - height/(6.0*radius)), 1.4)
	var foot := Vector3(hub.x, surface_y, hub.z)
	set_source(slot, foot, hub, 2.1*radius+0.06*height, Vector4(19, 8, -9, 22)*gain, Vector4(9, 0, 0.45 if over_water else 0.0, 0.5)*gain, 0.3)

## A moving tapered funnel can use distinct foot and cloud anchors.
func set_vortex(slot: int, foot: Vector3, cloud: Vector3, radius: float, strength: float, over_water: bool) -> void:
	var gain := maxf(0.0, strength)
	set_source(slot, foot, cloud, radius*2.15, Vector4(-9, 38, 32, 2)*gain, Vector4(-5, 0, 0.38 if over_water else 0.0, 0.6)*gain, 0.3)

func _delta(slot: int, p: Vector3) -> Vector3:
	var a := _a[slot]
	var axis := _axis[slot]
	var ab := Vector3(axis.x, axis.y, axis.z)
	var ap := p - Vector3(a.x, a.y, a.z)
	return ap - ab * clampf(ap.dot(ab) * axis.w, 0.0, 1.0)

func fields_at(p: Vector3) -> Vector4:
	var result := Vector4(0.0, ambient_temperature, surface_wetness, 0.0)
	for i in _count:
		var q := _delta(i, p).length_squared() * _a[i].w
		if q < 1.0:
			result += _live[i] * (1.0 - q) * (1.0 - q)
	result.z = clampf(result.z, 0.0, 1.0)
	result.w = clampf(result.w, 0.0, 1.0)
	return result

func wind_at(p: Vector3) -> Vector3:
	var result := ambient_wind
	for i in _count:
		if _remaining[i] <= 0.0:
			continue
		var d := _delta(i, p)
		var q := d.length_squared() * _a[i].w
		if q < 1.0:
			var v := _wind[i]
			var moving := (d*v.x + d.cross(_spin[i])*v.y) / maxf(d.length(), 0.05)
			moving.y += v.z + 4.0*q*v.w
			result += moving * (1.0-q) * (1.0-q) * smoothstep(0.0, _duration[i], _remaining[i])
	return result

func pressure_force_at(point: Vector3) -> Vector3:
	var force := Vector3.ZERO
	for i in _count:
		if _live[i].x == 0.0:
			continue
		var offset := _delta(i, point)
		var inv_radius_squared := _a[i].w
		var q := offset.length_squared()*inv_radius_squared
		if q < 1.0:
			force += offset*(4.0*(1.0-q)*_live[i].x*inv_radius_squared)
	return force

func _drive_body(body: RigidBody3D, dt: float) -> void:
	var p := body.global_transform * body.center_of_mass
	var air := wind_at(p)
	var pressure := pressure_force_at(p)
	if air.length_squared() < 0.16 and pressure.length_squared() < 0.001:
		return
	var slip := air - body.linear_velocity
	var scale := pow(body.mass, 1.0/3.0)
	var rate := dt*(2.8+0.15*minf(70.0, slip.length()))/scale
	body.apply_central_impulse(slip*(body.mass*rate/(1.0+rate)) + pressure*(scale*scale*dt))

func _physics_process(delta: float) -> void:
	surface_wetness = clampf(surface_wetness + delta * (rainfall*0.45*(1.0-surface_wetness) - (1.0-rainfall)*0.018), 0.0, 1.0)
	for i in _count:
		_remaining[i] = maxf(0.0, _remaining[i] - delta)
		_live[i] = _fields[i] * smoothstep(0.0, maxf(_duration[i], 0.00001), _remaining[i])
	while _count > 0 and _remaining[_count-1] <= 0.0:
		_count -= 1
	for body in driven_bodies:
		if is_instance_valid(body) and not body.freeze:
			_drive_body(body, delta)
	for material in materials:
		if material:
			material.set_shader_parameter("field_count", _count)
			material.set_shader_parameter("source_start", _a)
			material.set_shader_parameter("source_axis", _axis)
			material.set_shader_parameter("source_scalar", _live)
			material.set_shader_parameter("rain_film", surface_wetness)
