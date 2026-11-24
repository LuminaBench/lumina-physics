using System;
using UnityEngine;

namespace LuminaPhysics
{
    [Serializable]
    public class LuminaLook
    {
        public string name, waterTint, foliageTint, skyTint, seaState;
        public float foam, foamBands, cloudBands, temperature, tint, saturation, contrast, exposureBias, grassDensity;
    }

    [Serializable]
    public class LuminaWorldProfile
    {
        public int profileVersion;
        public long seed = 7;
        public float time = 15;
        public string mode = "fresh", biome = "coastal-cliffs", look = "natural-daylight", weather = "mixed", quality = "auto";
        public string[] locks, modules, rationale;
        public LuminaLook values;

        [Serializable] private class Library { public LuminaLook[] looks; }

        // Supply the exported resolved profile to carry exact overrides and locked values across engines.
        public static LuminaWorldProfile Load(TextAsset profileJson, TextAsset lookLibrary)
        {
            var profile = JsonUtility.FromJson<LuminaWorldProfile>(profileJson.text);
            if (profile == null || profile.profileVersion != 1)
                throw new FormatException("Expected a Lumina world profile version 1.");
            var library = JsonUtility.FromJson<Library>(lookLibrary.text);
            if (library == null || library.looks == null) throw new FormatException("Missing Lumina look library.");
            var palette = Array.Find(library.looks, item => item.name == profile.look);
            if (palette == null) throw new FormatException("Unknown Lumina world look: " + profile.look);
            if (profile.values == null || string.IsNullOrEmpty(profile.values.waterTint)) profile.values = palette;
            return profile;
        }
    }
}
