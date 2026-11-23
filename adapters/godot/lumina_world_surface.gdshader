shader_type spatial;
uniform vec4 source_start[16];
uniform vec4 source_axis[16];
uniform vec4 source_scalar[16];
uniform int field_count = 0;
uniform float rain_film = 0.0;
uniform vec4 dry_color : source_color = vec4(0.42,0.38,0.32,1.0);
varying vec3 world_position;
void vertex() {
	world_position = (MODEL_MATRIX * vec4(VERTEX,1.0)).xyz;
}
void fragment() {
	vec4 field = vec4(0.0,0.0,rain_film,0.0);
	for (int i=0; i<field_count; i++) {
		vec3 ap=world_position-source_start[i].xyz;
		vec4 axis=source_axis[i];
		vec3 d=ap-axis.xyz*clamp(dot(ap,axis.xyz)*axis.w,0.0,1.0);
		float w=max(0.0,1.0-dot(d,d)*source_start[i].w);
		field+=source_scalar[i]*w*w;
	}
	float wet=clamp(field.z,0.0,1.0);
	ALBEDO=dry_color.rgb*mix(1.0,0.48,wet);
	ROUGHNESS=mix(0.83,0.17,wet);
	EMISSION=vec3(1.1,0.23,0.03)*smoothstep(90.0,240.0,field.y);
}
