// ============================================================================
// Valence-Guard Plugin — Validates emotionalValence field on events
// ============================================================================

/**
 * @typedef {import('../../../../../packages/core/src/types/validator.js').Validator} Validator
 * @typedef {import('../../../../../packages/core/src/plugin/validator-registry.js').ValidatorRegistry} ValidatorRegistry
 * @typedef {import('../../../../../packages/core/src/plugin/types.js').PluginHooks} PluginHooks
 * @typedef {import('../../../../../packages/core/src/plugin/types.js').PluginContext} PluginContext
 * @typedef {import('../../../../../packages/core/src/types/validator.js').PreRenderInput} PreRenderInput
 * @typedef {import('../../../../../packages/core/src/types/validator.js').ValidationIssue} ValidationIssue
 */

/** @type {Validator} */
const valenceValidator = {
  name: 'valence-guard',
  category: 'factual_detail',
  /**
   * @param {PreRenderInput} input
   * @returns {ValidationIssue[]}
   */
  validatePre(input) {
    const event = input.event;
    if (!event || event.emotionalValence != null) {
      return [];
    }
    return [
      {
        validator: 'valence-guard',
        severity: 'error',
        event: event.event ?? String(event.narrativeOrder),
        entity: '',
        message: `Event "${event.title ?? 'unknown'}" is missing required field "emotionalValence"`,
        fixSuggestion: 'Add an emotionalValence field describing the emotional tone of this scene',
        fixAction: 'add_field',
        fixTarget: { file: '', field: 'emotionalValence' },
      },
    ];
  },
};

/**
 * Plugin lifecycle hooks.
 * @type {PluginHooks}
 */
export const hooks = {
  name: 'valence-guard',

  /**
   * Register the valence validator with the ValidatorRegistry.
   * @param {ValidatorRegistry} registry
   */
  registerValidators(registry) {
    registry.register(valenceValidator);
  },

  /**
   * Called before rendering a scene.
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async beforeRender(ctx) {
    ctx.log.info('valence-guard hook', { hook: 'beforeRender' });
  },

  /**
   * Called after rendering a scene.
   * @param {PluginContext} ctx
   * @returns {Promise<void>}
   */
  async afterRender(ctx) {
    ctx.log.info('valence-guard hook', { hook: 'afterRender' });
  },
};
