function getTaskModels() {
  return {
    generate: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_GENERATE_PRIMARY || "nvidia/nemotron-3-ultra-550b-a55b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_GENERATE_SECONDARY || "nvidia/nemotron-3-super-120b-a12b:free",
      openrouterTertiary: process.env.OPENROUTER_MODEL_GENERATE_TERTIARY || "nvidia/nemotron-3-nano-30b-a3b:free"
      // REMOVED: openrouterRouter (was random router)
    },
    repair: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_REPAIR_PRIMARY || "nvidia/nemotron-3-nano-30b-a3b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_REPAIR_SECONDARY || "openrouter/free"
    },
    explain: {
      openrouterPrimary: process.env.OPENROUTER_MODEL_EXPLAIN_PRIMARY || "nvidia/nemotron-3-ultra-550b-a55b:free",
      openrouterSecondary: process.env.OPENROUTER_MODEL_EXPLAIN_SECONDARY || "nvidia/nemotron-3-super-120b-a12b:free",
      openrouterTertiary: process.env.OPENROUTER_MODEL_EXPLAIN_TERTIARY || "nvidia/nemotron-3-nano-30b-a3b:free"
    }
  };
}
