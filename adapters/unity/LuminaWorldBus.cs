using UnityEngine;

namespace LuminaPhysics
{
    /// CPU and shader field samples use the same 16 finite swept-sphere sources.
    public sealed class LuminaWorldBus : MonoBehaviour
    {
        const int Capacity = 16;
        public Vector3 AmbientWind;
        public Rigidbody[] DrivenBodies = new Rigidbody[0];
        public float AmbientTemperature = 18f;
        [Range(0f, 1f)] public float Rainfall;
        public float SurfaceWetness { get; private set; }
        readonly Vector4[] starts = new Vector4[Capacity], axes = new Vector4[Capacity];
        readonly Vector4[] winds = new Vector4[Capacity], scalar = new Vector4[Capacity], live = new Vector4[Capacity];
        readonly float[] remaining = new float[Capacity], duration = new float[Capacity];
        readonly Vector3[] spin = new Vector3[Capacity];
        int count;

        public void SetSource(int slot, Vector3 start, Vector3 end, float radius, Vector4 wind, Vector4 fields, float life, bool axialSwirl = false)
        {
            if (slot < 0 || slot >= Capacity || radius <= 0f || life <= 0f) return;
            Vector3 axis = end - start;
            starts[slot] = new Vector4(start.x, start.y, start.z, 1f/(radius*radius));
            axes[slot] = new Vector4(axis.x, axis.y, axis.z, 1f/Mathf.Max(1e-6f,axis.sqrMagnitude));
            spin[slot] = axialSwirl && axis.sqrMagnitude > 1e-6f ? axis.normalized : Vector3.up;
            winds[slot] = wind;
            live[slot] = scalar[slot] = fields;
            duration[slot] = remaining[slot] = life;
            count = Mathf.Max(count, slot+1);
        }

        /// Refresh once per physics tick using the local ground or water elevation.
        public void SetRotor(int slot, Vector3 hub, float radius, float load, float surfaceY, bool overWater)
        {
            if (radius <= 0f) return;
            float height = Mathf.Max(0f, hub.y - surfaceY);
            float gain = Mathf.Clamp01(load) * Mathf.Pow(Mathf.Max(0f, 1f - height / (6f * radius)), 1.4f);
            Vector3 foot = new Vector3(hub.x, surfaceY, hub.z);
            SetSource(slot, foot, hub, 2.1f * radius + 0.06f * height, new Vector4(19f,8f,-9f,22f) * gain,
                new Vector4(9f,0f,overWater ? 0.45f : 0f,0.5f) * gain, 0.3f);
        }

        public void SetVortex(int slot, Vector3 foot, Vector3 cloud, float radius, float strength, bool overWater)
        {
            float gain = Mathf.Max(0f, strength);
            SetSource(slot, foot, cloud, 2.15f * radius, new Vector4(-9f,38f,32f,2f) * gain,
                new Vector4(-5f,0f,overWater ? 0.38f : 0f,0.6f) * gain, 0.3f);
        }

        public void Sample(Vector3 point, out Vector3 wind, out Vector4 fields)
        {
            Sample(point, out wind, out fields, out _);
        }

        public void Sample(Vector3 point, out Vector3 wind, out Vector4 fields, out Vector3 pressureForce)
        {
            pressureForce = Vector3.zero;
            wind = AmbientWind;
            fields = new Vector4(0f,AmbientTemperature,SurfaceWetness,0f);
            for (int i=0;i<count;i++)
            {
                if (remaining[i] <= 0f) continue;
                Vector3 axis = axes[i], ap = point-(Vector3)starts[i];
                Vector3 d = ap-axis*Mathf.Clamp01(Vector3.Dot(ap,axis)*axes[i].w);
                float q=d.sqrMagnitude*starts[i].w;
                if(q>=1f) continue;
                float w=(1f-q)*(1f-q);
                fields += live[i]*w;
                pressureForce += d * (4f * (1f - q) * live[i].x * starts[i].w);
                Vector4 v=winds[i];
                Vector3 drift=(d*v.x+Vector3.Cross(d,spin[i])*v.y)/Mathf.Max(0.05f,d.magnitude);
                drift.y += v.z + 4f*q*v.w;
                wind += drift*w*Mathf.SmoothStep(0f,1f,remaining[i]/duration[i]);
            }
            fields.z=Mathf.Clamp01(fields.z); fields.w=Mathf.Clamp01(fields.w);
        }

        void FixedUpdate()
        {
            float dt=Time.fixedDeltaTime;
            SurfaceWetness=Mathf.Clamp01(SurfaceWetness+dt*(Rainfall*0.45f*(1f-SurfaceWetness)-(1f-Rainfall)*0.018f));
            for(int i=0;i<count;i++)
            {
                remaining[i]=Mathf.Max(0f,remaining[i]-dt);
                live[i]=scalar[i]*Mathf.SmoothStep(0f,1f,remaining[i]/Mathf.Max(1e-5f,duration[i]));
            }
            while(count>0 && remaining[count-1]<=0f) count--;
            foreach (Rigidbody body in DrivenBodies)
            {
                if (!body || body.isKinematic) continue;
                Sample(body.worldCenterOfMass, out Vector3 air, out _, out Vector3 pressure);
                if (air.sqrMagnitude < 0.16f && pressure.sqrMagnitude < 0.001f) continue;
#if UNITY_6000_0_OR_NEWER
                Vector3 slip = air - body.linearVelocity;
#else
                Vector3 slip = air - body.velocity;
#endif
                float scale = Mathf.Pow(body.mass, 1f/3f);
                float rate = dt * (2.8f + 0.15f * Mathf.Min(70f, slip.magnitude)) / scale;
                body.AddForce(slip * (body.mass * rate / (1f + rate)) + pressure * (scale * scale * dt), ForceMode.Impulse);
            }
            Shader.SetGlobalInt("_LuminaFieldCount",count);
            Shader.SetGlobalFloat("_LuminaRainFilm",SurfaceWetness);
            Shader.SetGlobalVectorArray("_LuminaFieldStart",starts);
            Shader.SetGlobalVectorArray("_LuminaFieldAxis",axes);
            Shader.SetGlobalVectorArray("_LuminaFieldScalar",live);
        }

        void OnDisable()
        {
            Shader.SetGlobalInt("_LuminaFieldCount",0);
            Shader.SetGlobalFloat("_LuminaRainFilm",0f);
        }
    }
}
