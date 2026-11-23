class_name LuminaThermoField
extends Node3D
## Temperature / fuel / moisture field: fire spread, charring, steam (spec 12).
##
## Port of `modules/thermo/thermo.ts`. A small grid over a patch of ground (the node's
## XZ position is its centre) stepped at 20 Hz:
##   combustion  fuel above 280 C burns unless it is soaked, heating toward 950 C
##   spread      conduction + radiant pre-heating, both leaning downwind
##   water       rain soaks and cools; moisture on hot cells boils off as steam
## `texture` (R = temperature / 1200, G = char, B = wetness, A = burning) is ready to
## sample from a ground shader for scorch marks, ember glow and wet patches.

signal ignited(at: Vector3)
signal steam(at: Vector3, strength: float)

const AMBIENT := 22.0
const IGNITION := 280.0
const FLAME := 950.0
const STEP := 1.0 / 20.0


@export var size := 40.0
@export var resolution := 96
## Wind velocity in m/s (set it from your weather system).
@export var wind := Vector3(6.0, 0.0, 2.0)
@export_range(0.0, 1.0) var rain := 0.0

var texture: ImageTexture
var burning_cells := 0
var charred_cells := 0
var intensity := 0.0

var _t := PackedFloat32Array()
var _t2 := PackedFloat32Array()
var _fuel := PackedFloat32Array()
var _fuel0 := PackedFloat32Array()
var _wet := PackedFloat32Array()
var _char := PackedFloat32Array()
var _burn := PackedFloat32Array()
var _image: Image
var _accumulator := 0.0
var _active := false


func _ready() -> void:
	var n := resolution * resolution
	for array in [_t, _t2, _fuel, _fuel0, _wet, _char, _burn]:
		array.resize(n)
	_t.fill(AMBIENT)
	_t2.fill(AMBIENT)
	_image = Image.create(resolution, resolution, false, Image.FORMAT_RGBA8)
	texture = ImageTexture.create_from_image(_image)


func _cell() -> float:
	return size / float(resolution)


func _index(x: float, z: float) -> int:
	var u := (x - global_position.x) / size + 0.5
	var v := (z - global_position.z) / size + 0.5
	if u < 0.0 or u >= 1.0 or v < 0.0 or v >= 1.0:
		return -1
	return int(v * resolution) * resolution + int(u * resolution)


func _world_of(i: int) -> Vector3:
	var r := float(resolution)
	return Vector3((float(i % resolution) + 0.5) / r * size - size * 0.5 + global_position.x, global_position.y, (float(i / resolution) + 0.5) / r * size - size * 0.5 + global_position.z)


func _for_disc(x: float, z: float, radius: float, fn: Callable) -> void:
	var cell := _cell()
	var cu := (x - global_position.x) / size * resolution + resolution * 0.5
	var cv := (z - global_position.z) / size * resolution + resolution * 0.5
	var span := int(ceil(radius / cell))
	for v in range(maxi(0, int(cv) - span), mini(resolution - 1, int(cv) + span) + 1):
		for u in range(maxi(0, int(cu) - span), mini(resolution - 1, int(cu) + span) + 1):
			var d := Vector2(u + 0.5 - cu, v + 0.5 - cv).length() * cell
			if d <= radius:
				fn.call(v * resolution + u, 1.0 - d / maxf(radius, 0.001))


## Lay fuel in a disc (kg/m2): 0.5 dry grass, 2-4 timber decking, 1.5 a petrol film.
func add_fuel(x: float, z: float, radius: float, amount: float) -> void:
	_for_disc(x, z, radius, func(i: int, _k: float) -> void:
		_fuel[i] += amount
		_fuel0[i] = maxf(_fuel0[i], _fuel[i]))


## Raise a disc to flame temperature (a match, a flare, a spark).
func ignite(x: float, z: float, radius := 0.8) -> void:
	_for_disc(x, z, radius, func(i: int, k: float) -> void:
		_t[i] = maxf(_t[i], IGNITION + 420.0 * (0.4 + 0.6 * k))
		_wet[i] *= 0.3)
	_active = true
	ignited.emit(Vector3(x, global_position.y, z))


func heat(x: float, z: float, radius: float, degrees: float) -> void:
	_for_disc(x, z, radius, func(i: int, k: float) -> void: _t[i] = minf(1400.0, _t[i] + degrees * k))
	_active = true


## Throw water on a disc: soaks it and carries heat away (steam where it is hot).
func quench(x: float, z: float, radius: float, amount := 1.0) -> void:
	_for_disc(x, z, radius, func(i: int, k: float) -> void: _wet[i] = minf(1.0, _wet[i] + amount * (0.4 + 0.6 * k)))
	_active = true


func temperature_at(x: float, z: float) -> float:
	var i := _index(x, z)
	return AMBIENT if i < 0 else _t[i]


func is_burning(x: float, z: float) -> bool:
	var i := _index(x, z)
	return i >= 0 and _burn[i] > 0.02


func wetness_at(x: float, z: float) -> float:
	var i := _index(x, z)
	return 0.0 if i < 0 else _wet[i]


func char_at(x: float, z: float) -> float:
	var i := _index(x, z)
	return 0.0 if i < 0 else _char[i]


func _physics_process(delta: float) -> void:
	if not _active and rain <= 0.0:
		return
	_accumulator = minf(_accumulator + delta, STEP * 3.0)
	while _accumulator >= STEP:
		_step()
		_accumulator -= STEP


func _step() -> void:
	var r := resolution
	var cell := _cell()
	var speed := Vector2(wind.x, wind.z).length()
	var wx := wind.x / speed if speed > 0.01 else 0.0
	var wz := wind.z / speed if speed > 0.01 else 0.0
	var lean := minf(1.0, speed / 14.0)
	var any_hot := false
	var area := 0.0
	var steam_total := 0.0
	var steam_at := Vector3.ZERO
	burning_cells = 0
	charred_cells = 0
	for i in r * r:
		var t := _t[i]
		var rate := 0.0
		if _fuel[i] > 0.0 and t > IGNITION and _wet[i] < 0.4:
			rate = 0.055 * (0.35 + 0.65 * minf(1.0, (t - IGNITION) / 320.0)) * (1.0 - _wet[i] / 0.4) * (0.75 + 0.5 * lean)
			_fuel[i] = maxf(0.0, _fuel[i] - rate * _fuel0[i] * STEP)
			t += (FLAME - t) * minf(1.0, 2.6 * STEP)
			_char[i] = maxf(_char[i], 1.0 - _fuel[i] / maxf(_fuel0[i], 0.0001))
		elif _fuel0[i] > 0.0 and t > 180.0:
			_char[i] = minf(1.0, _char[i] + (t - 180.0) * 0.0006)
		_burn[i] = minf(1.0, rate * 18.0)
		if rain > 0.0:
			_wet[i] = minf(1.0, _wet[i] + rain * 0.5 * STEP)
			t -= (t - AMBIENT) * rain * 0.9 * STEP
		if _wet[i] > 0.0 and t > 100.0:
			# Finite boil-off: light rain only cools a fire, heavy rain or a hose drowns it.
			var boiled := minf(_wet[i], (t - 100.0) * 0.00044 * STEP)
			_wet[i] -= boiled
			t = maxf(60.0, t - boiled * 520.0)
			if boiled > 0.0015:
				steam_total += boiled
				steam_at = _world_of(i)
		elif _wet[i] > 0.0:
			_wet[i] = maxf(0.0, _wet[i] - (0.006 + 0.0004 * maxf(0.0, t - AMBIENT)) * STEP * (1.0 - rain))
		t -= (t - AMBIENT) * (0.16 + 0.1 * lean) * STEP
		_t[i] = t
		if rate > 0.0:
			burning_cells += 1
			area += _burn[i]
		if _char[i] > 0.3:
			charred_cells += 1
		if t > AMBIENT + 2.0 or _wet[i] > 0.01:
			any_hot = true
	# Conduction + radiant pre-heating, both leaning downwind.
	var conduct := minf(0.02, 0.0009 * STEP / (cell * cell) * 30.0)
	for v in r:
		for u in r:
			var i := v * r + u
			var acc := 0.0
			var radiant := 0.0
			for dv in range(-1, 2):
				for du in range(-1, 2):
					if du == 0 and dv == 0:
						continue
					var uu := u + du
					var vv := v + dv
					if uu < 0 or vv < 0 or uu >= r or vv >= r:
						continue
					var j := vv * r + uu
					var length := 1.4142 if du != 0 and dv != 0 else 1.0
					var along := (-du * wx - dv * wz) / length
					var bias := 1.0 + lean * 2.2 * maxf(0.0, along) - lean * 0.75 * maxf(0.0, -along)
					acc += (_t[j] - _t[i]) * bias / length
					if _burn[j] > 0.0:
						radiant += _burn[j] * bias * bias / length
			var t := _t[i] + acc * conduct
			if radiant > 0.0 and _fuel[i] > 0.0 and _burn[i] == 0.0:
				t += radiant * (26.0 + 60.0 * lean) * STEP * (1.0 - 0.85 * _wet[i])
			_t2[i] = minf(1400.0, t)
	var swap := _t
	_t = _t2
	_t2 = swap
	intensity = area * cell * cell
	if steam_total > 0.01:
		steam.emit(steam_at, minf(1.0, steam_total * 2.0 + 0.2))
	_active = any_hot or burning_cells > 0
	_publish()


func _publish() -> void:
	var data := PackedByteArray()
	data.resize(resolution * resolution * 4)
	for i in resolution * resolution:
		data[i * 4] = int(clampf(_t[i] / 1200.0, 0.0, 1.0) * 255.0)
		data[i * 4 + 1] = int(_char[i] * 255.0)
		data[i * 4 + 2] = int(_wet[i] * 255.0)
		data[i * 4 + 3] = int(_burn[i] * 255.0)
	_image.set_data(resolution, resolution, false, Image.FORMAT_RGBA8, data)
	texture.update(_image)
