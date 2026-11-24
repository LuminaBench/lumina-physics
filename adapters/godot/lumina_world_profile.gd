class_name LuminaWorldProfile
extends RefCounted

## Read saved profile JSON and the installed world-looks.json palette library.
static func from_json(profile_json: String, looks_json: String) -> Dictionary:
	var profile = JSON.parse_string(profile_json)
	var library = JSON.parse_string(looks_json)
	if not profile is Dictionary or profile.get("profileVersion") != 1:
		push_error("Expected a Lumina world profile version 1.")
		return {}
	if not library is Dictionary or not library.get("looks") is Array:
		push_error("Expected the Lumina look library.")
		return {}
	var look: String = profile.get("look", "natural-daylight")
	for palette in library.looks:
		if palette.name == look:
			var values: Dictionary = palette.duplicate(true)
			values.erase("name")
			values.merge(profile.get("overrides", {}), true)
			values.merge(profile.get("values", {}), true)
			profile["values"] = values
			profile["look"] = look
			return profile
	push_error("Unknown Lumina world look: " + look)
	return {}
