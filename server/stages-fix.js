    // OpenRouter stages FIRST (primary provider)
    if (process.env.OPENROUTER_API_KEY) {
      const isFreeModel = (model) => model && model.includes(":free");

      // Primary stage
      if (taskConfig.openrouterPrimary) {
        const primaryIsFree = isFreeModel(taskConfig.openrouterPrimary);
        stages.push({
          name: "openrouter-primary",
          provider: "openrouter",
          model: taskConfig.openrouterPrimary,
          repairModel: repairConfig.openrouterPrimary,
          useReasoning: primaryIsFree,
          systemPrompt: roleConfig.system,
          temperature: roleConfig.temperature,
          maxTokens: roleConfig.maxTokens
        });
      }

      // Secondary stage
      if (taskConfig.openrouterSecondary) {
        const secondaryIsFree = isFreeModel(taskConfig.openrouterSecondary);
        stages.push({
          name: "openrouter-secondary",
          provider: "openrouter",
          model: taskConfig.openrouterSecondary,
          repairModel: repairConfig.openrouterSecondary,
          useReasoning: secondaryIsFree,
          systemPrompt: roleConfig.system,
          temperature: roleConfig.temperature,
          maxTokens: roleConfig.maxTokens
        });
      }

      // Tertiary stage (for generate and explain tasks)
      if (taskConfig.openrouterTertiary) {
        const tertiaryIsFree = isFreeModel(taskConfig.openrouterTertiary);
        stages.push({
          name: "openrouter-tertiary",
          provider: "openrouter",
          model: taskConfig.openrouterTertiary,
          repairModel: repairConfig.openrouterSecondary,
          useReasoning: tertiaryIsFree,
          systemPrompt: roleConfig.system,
          temperature: roleConfig.temperature,
          maxTokens: roleConfig.maxTokens
        });
      }

      // REMOVED: openrouter-router (random router)
    }
