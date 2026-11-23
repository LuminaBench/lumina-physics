// lumina-physics · context-aware explosion archetypes (specs/08).
// Assign ParticleSystems (or VFX Graph wrappers) per pool and a point light for the flash.
using System;
using UnityEngine;

namespace Lumina.Physics
{
    public enum LuminaExplosionKind { Petrol, C4, Water, Electrical }

    public class LuminaExplosion : MonoBehaviour
    {
        [Serializable]
        public struct Archetype
        {
            public Color flash; public float flashIntensity, flashDecay, blastRadius, impulse, trauma, waterImpulse;
        }

        // Yield-1 tuning (see the table in specs/08).
        static readonly Archetype[] Table =
        {
            new Archetype { flash = new Color(1f, 0.54f, 0.23f), flashIntensity = 55f,  flashDecay = 1.5f, blastRadius = 15f, impulse = 900f,  trauma = 0.6f,  waterImpulse = -0.55f },
            new Archetype { flash = new Color(1f, 0.96f, 0.89f), flashIntensity = 450f, flashDecay = 16f,  blastRadius = 32f, impulse = 5200f, trauma = 1.6f,  waterImpulse = -1.2f },
            new Archetype { flash = new Color(0.81f, 0.91f, 1f), flashIntensity = 4f,   flashDecay = 14f,  blastRadius = 34f, impulse = 3400f, trauma = 0.85f, waterImpulse = -2f },
            new Archetype { flash = new Color(0.61f, 0.77f, 1f), flashIntensity = 90f,  flashDecay = 28f,  blastRadius = 7f,  impulse = 240f,  trauma = 0.32f, waterImpulse = 0f },
        };

        public ParticleSystem fire, smoke, sparks, spray, mist;
        public Light flashLight;
        public float waterLevel;

        /// <summary>Raised at detonation with kind, position and intensity.</summary>
        public static event Action<string, Vector3, float> Explosion;
        /// <summary>Camera trauma 0..1 for the active camera rig.</summary>
        public static event Action<float> CameraTrauma;
        /// <summary>(position, radius, impulse metres, foam) for the water interaction field.</summary>
        public static event Action<Vector3, float, float, float> WaterImpulse;

        float flashIntensity, flashDecay = 1f;
        static readonly Collider[] Hits = new Collider[64];

        public void Detonate(LuminaExplosionKind kind, float yield = 1f)
        {
            Archetype a = Table[(int)kind];
            ParticleSystem[] pools = kind switch
            {
                LuminaExplosionKind.Petrol => new[] { fire, smoke, sparks },
                LuminaExplosionKind.C4 => new[] { fire, smoke, sparks, mist },
                LuminaExplosionKind.Water => new[] { spray, mist },
                _ => new[] { sparks, smoke },
            };
            foreach (ParticleSystem pool in pools)
            {
                if (pool == null) continue;
                pool.transform.localScale = Vector3.one * yield;
                pool.Clear();
                pool.Play();
            }
            if (flashLight != null)
            {
                flashLight.color = a.flash;
                flashIntensity = a.flashIntensity * yield * yield;
                flashDecay = a.flashDecay;
                flashLight.range = a.blastRadius * 3f * yield;
            }
            Blast(a.blastRadius * yield, a.impulse * yield, kind == LuminaExplosionKind.Water ? 1.2f : 0.35f);
            float distance = Camera.main != null ? Vector3.Distance(Camera.main.transform.position, transform.position) : 0f;
            CameraTrauma?.Invoke(Mathf.Pow(Mathf.Min(1f, 38f * a.trauma * yield / (distance + 12f)), 1.25f));
            Explosion?.Invoke(kind.ToString().ToLowerInvariant(), transform.position, Mathf.Min(1f, yield));
            if (a.waterImpulse != 0f && transform.position.y - waterLevel < 5f)
                WaterImpulse?.Invoke(transform.position, 6.5f * yield, a.waterImpulse * yield, 8f);
        }

        /// <summary>Radial impulse with inverse-square-ish falloff and a slight upward bias.</summary>
        void Blast(float radius, float impulse, float upBias)
        {
            int count = UnityEngine.Physics.OverlapSphereNonAlloc(transform.position, radius, Hits);
            for (int i = 0; i < count; i++)
            {
                Rigidbody body = Hits[i].attachedRigidbody;
                if (body == null || body.isKinematic) continue;
                Vector3 offset = body.worldCenterOfMass - transform.position;
                float dist = Mathf.Max(offset.magnitude, 0.25f);
                float fall = Mathf.Pow(1f - Mathf.Min(dist / radius, 1f), 2f);
                Vector3 dir = (offset / dist + Vector3.up * upBias).normalized;
                body.AddForce(dir * impulse * fall * Mathf.Min(1f, Mathf.Pow(body.mass, 1f / 3f) * 0.6f + 0.2f), ForceMode.Impulse);
                body.AddTorque(UnityEngine.Random.insideUnitSphere * impulse * fall * 0.04f, ForceMode.Impulse);
            }
        }

        void Update()
        {
            if (flashLight == null) return;
            flashIntensity *= Mathf.Exp(-flashDecay * Time.deltaTime);
            flashLight.intensity = flashIntensity;
        }
    }
}
