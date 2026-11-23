## lumina-physics · 5-tier quality presets for Godot 4.3+ (Forward+).
## Add as an autoload named `LuminaQuality`, then call `LuminaQuality.apply("high")`.
extends Node

signal tier_changed(tier: String, preset: Dictionary)

const TIERS := ["low", "medium", "high", "xhigh", "ultra"]

const PRESETS := {
	"low":    { "render_scale": 0.67, "taa": true,  "wave_count": 16, "geometry_waves": 8,  "particles": 2048,  "ssr": false, "ssao": false, "shadow_size": 1024, "volumetric_fog": false, "debris": 24 },
	"medium": { "render_scale": 0.77, "taa": true,  "wave_count": 32, "geometry_waves": 12, "particles": 8192,  "ssr": false, "ssao": false, "shadow_size": 2048, "volumetric_fog": false, "debris": 48 },
	"high":   { "render_scale": 1.0,  "taa": true,  "wave_count": 48, "geometry_waves": 16, "particles": 20480, "ssr": true,  "ssao": true,  "shadow_size": 4096, "volumetric_fog": true,  "debris": 96 },
	"xhigh":  { "render_scale": 1.0,  "taa": true,  "wave_count": 56, "geometry_waves": 20, "particles": 49152, "ssr": true,  "ssao": true,  "shadow_size": 4096, "volumetric_fog": true,  "debris": 160 },
	"ultra":  { "render_scale": 1.0,  "taa": true,  "wave_count": 64, "geometry_waves": 24, "particles": 90112, "ssr": true,  "ssao": true,  "shadow_size": 8192, "volumetric_fog": true,  "debris": 256 },
}

var tier := "high"
var preset: Dictionary = PRESETS["high"]

## Heuristic starting tier from the rendering device.
func detect() -> String:
	var name := RenderingServer.get_video_adapter_name().to_lower()
	var type := RenderingServer.get_video_adapter_type()
	if OS.has_feature("mobile") or type == RenderingDevice.DEVICE_TYPE_CPU:
		return "low"
	if type == RenderingDevice.DEVICE_TYPE_INTEGRATED_GPU and not name.contains("apple"):
		return "medium"
	if name.contains("rtx") or name.contains("radeon rx") or name.contains("apple m"):
		return "xhigh"
	return "high"

func apply(new_tier: String, environment: Environment = null) -> void:
	if not PRESETS.has(new_tier):
		push_warning("LuminaQuality: unknown tier %s" % new_tier)
		return
	tier = new_tier
	preset = PRESETS[new_tier]
	var viewport := get_viewport()
	viewport.scaling_3d_scale = preset["render_scale"]
	# Temporal upscaling below native resolution, TAA at native: the DLSS-style resolve.
	viewport.scaling_3d_mode = Viewport.SCALING_3D_MODE_FSR2 if preset["render_scale"] < 1.0 else Viewport.SCALING_3D_MODE_BILINEAR
	viewport.use_taa = preset["taa"] and preset["render_scale"] >= 1.0
	viewport.msaa_3d = Viewport.MSAA_DISABLED
	RenderingServer.directional_shadow_atlas_set_size(preset["shadow_size"], true)
	if environment:
		environment.ssr_enabled = preset["ssr"]
		environment.ssao_enabled = preset["ssao"]
		environment.volumetric_fog_enabled = preset["volumetric_fog"]
		environment.tonemap_mode = Environment.TONE_MAPPER_AGX if "TONE_MAPPER_AGX" in Environment else Environment.TONE_MAPPER_ACES
		environment.glow_enabled = true
		environment.glow_hdr_threshold = 1.15
	tier_changed.emit(tier, preset)
