// ============================================================================
// Novalistically — STATE-6: Rule Schema Definitions (Zod)
// ============================================================================

import { z } from 'zod/v3';

// ——— Identity schemas ———

export const ruleIdSchema = z.string();
export const ruleEpochIdSchema = z.string();
export const ruleExceptionIdSchema = z.string();
export const ruleSpecificationIdSchema = z.string();

// ——— RuleTypeDefinition schema ———

export const ruleClassSchema = z
  .enum(['natural_law', 'social_norm', 'moral_principle', 'game_rule', 'legal_code'])
  .optional();

export const rulePredicateSchema = z
  .object({
    version: z.string(),
    type: z.enum(['compiled', 'simple']),
    expression: z.string(),
    operators: z.array(z.enum(['all', 'exists', 'count'])).optional(),
  })
  .strict();

export const ruleConstraintKindSchema = z.enum([
  'state_invariant',
  'transition_constraint',
  'precondition_requirement',
  'postcondition_requirement',
]);

export const ruleEnforcementSchema = z.enum(['hard', 'audit', 'semantic']);

export const ruleApplicableEffectivenessSchema = z.enum(['full', 'limited', 'nullified']);

export const ruleConstraintSchema = z
  .object({
    constraintId: z.string(),
    kind: ruleConstraintKindSchema,
    enforcement: ruleEnforcementSchema,
    applicableEffectiveness: z.array(ruleApplicableEffectivenessSchema),
    scope: z.record(z.string(), z.unknown()),
    predicate: rulePredicateSchema,
    semanticHint: z.string().optional(),
  })
  .strict();

export const ruleTypeDefinitionSchema = z
  .object({
    typeId: z.string(),
    name: z.string(),
    category: z.string(),
    ruleClass: ruleClassSchema,
    defaultConstraints: z.array(ruleConstraintSchema),
  })
  .strict();

export const ruleTypeCatalogSchema = z
  .object({
    types: z.record(z.string(), ruleTypeDefinitionSchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    for (const [typeId, definition] of Object.entries(catalog.types)) {
      if (definition.typeId !== typeId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['types', typeId, 'typeId'],
          message: `Rule type map key "${typeId}" must match internal typeId "${definition.typeId}"`,
        });
      }
    }
  });

export const ruleSpecificationDeclarationSchema = z
  .object({
    statement: z.string(),
    constraints: z.array(ruleConstraintSchema),
  })
  .strict();

// ——— RuleSpecification schema ———

export const ruleSpecificationSchema = z
  .object({
    specificationId: ruleSpecificationIdSchema,
    typeRef: z
      .object({
        typeId: z.string(),
        version: z.string(),
      })
      .strict(),
    statement: z.string(),
    constraints: z.array(ruleConstraintSchema),
    semanticHash: z.string(),
  })
  .strict();

// ——— RuleRuntimeState schema ———

export const ruleActivationSchema = z.enum(['dormant', 'enabled', 'suspended', 'revoked']);
export const ruleEffectivenessSchema = z.enum(['full', 'limited', 'nullified']);

export const ruleExceptionConditionSchema = z
  .object({
    type: z.enum(['fact', 'expression']),
    factId: z.string().optional(),
    expression: z.string().optional(),
  })
  .strict();

export const ruleExceptionEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('exempt') }).strict(),
  z.object({ type: z.literal('replaceWith'), replacementConstraintId: z.string() }).strict(),
]);

export const ruleExceptionSchema = z
  .object({
    exceptionId: ruleExceptionIdSchema,
    status: z.enum(['active', 'suspended', 'revoked']),
    constraintIds: z.array(z.string()),
    scopeBindings: z.record(z.string(), z.unknown()),
    condition: ruleExceptionConditionSchema.optional(),
    effect: ruleExceptionEffectSchema,
  })
  .strict();

export const ruleDeclarationSchema = z
  .object({
    ruleId: ruleIdSchema,
    name: z.string(),
    typeId: z.string(),
    initialEpochId: ruleEpochIdSchema,
    initialSpecificationId: ruleSpecificationIdSchema,
    initialActivation: ruleActivationSchema,
    initialEffectiveness: ruleEffectivenessSchema,
    scopeBindings: z.record(z.string(), z.unknown()),
    exceptions: z.array(ruleExceptionSchema),
    specifications: z.record(ruleSpecificationIdSchema, ruleSpecificationDeclarationSchema),
  })
  .strict();

export const ruleRuntimeStateSchema = z
  .object({
    ruleId: ruleIdSchema,
    currentEpoch: ruleEpochIdSchema,
    specificationId: ruleSpecificationIdSchema,
    activation: ruleActivationSchema,
    effectiveness: ruleEffectivenessSchema,
    scopeBindings: z.record(z.string(), z.unknown()),
    exceptions: z.array(ruleExceptionSchema),
  })
  .strict();

// ——— RuleEvaluationRecord schema ———

export const ruleEvaluationResultSchema = z.enum(['compliant', 'violated', 'exempt']);

export const ruleEvaluationRecordSchema = z
  .object({
    evaluationId: z.string(),
    ruleId: ruleIdSchema,
    epochId: ruleEpochIdSchema,
    constraintId: z.string(),
    nodeId: z.string(),
    result: ruleEvaluationResultSchema,
    enforcement: ruleEnforcementSchema,
    details: z.string().optional(),
  })
  .strict();

// ——— RuleTransaction schema ———

export const ruleTransactionOperationSchema = z.enum([
  'enable',
  'suspend',
  'revoke',
  'amend',
  'replace',
  'set_effectiveness',
  'add_exception',
  'remove_exception',
]);

export const ruleTransactionSchema = z
  .object({
    type: z.literal('rule_transaction'),
    ruleId: ruleIdSchema,
    operation: ruleTransactionOperationSchema,
    evidence: z.string(),
    epochId: ruleEpochIdSchema.optional(),
    specificationId: ruleSpecificationIdSchema.optional(),
    newEffectiveness: ruleEffectivenessSchema.optional(),
    exception: ruleExceptionSchema.optional(),
    constraintEvaluation: z.array(ruleConstraintSchema).optional(),
  })
  .strict();

export const ruleExceptionStatusSchema = z.enum(['active', 'suspended', 'revoked']);
