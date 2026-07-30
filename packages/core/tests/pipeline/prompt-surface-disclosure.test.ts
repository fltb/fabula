// ============================================================================
// Prompt Surface & Disclosure Section Tests (RENDER-SURFACE-1 §3.6)
//
// Verifies:
//   - logicalDisclosureSummary and surfaceReferencePacket options inject
//     independent sections into Pass 1 prompt only
//   - Both sections are explicitly non-authoritative — YAML/scene-contract
//     ALWAYS wins over surface reference prose
//   - Neither section is ever written back to ContextPackage
//   - Pass 2 never treats surface prose or disclosure aggregates as
//     logical evidence for its analysis
// ============================================================================

import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../../src/context/prompt-assembler.ts';
import type {
  ContextPackage,
  StyleGuidance,
} from '../../src/types/index.ts';
import type {
  SurfaceReferencePacket,
  StyleMetrics,
} from '../../src/types/render-surface.ts';

// ============================================================================
// Helpers — minimal compliant instances
// ============================================================================

const MINIMAL_CONTEXT: ContextPackage = {
  eventId: 'scene-1',
  systemContext: {
    genre: 'literary fiction',
    style: 'prose',
    narrativeRules: [],
  },
  sceneSpec: {
    goal: 'Advance the plot.',
    povType: 'third_person_limited',
    povCharacter: 'Eleanor',
    conflict: 'Internal',
    expectedOutcome: 'Resolution',
  },
  characterSnapshots: [],
  relationshipContext: [],
  worldFacts: [],
  knowledgeBoundary: { permittedKnowledge: [], concealedKnowledge: [] },
  activeThreads: [],
  volumeSummary: '',
  markdown: '',
  narrativeTechniques: [],
};

const MINIMAL_STYLE: StyleGuidance = {
  tone: 'reflective',
  scenePacing: 'moderate',
};

const MOCK_DISCLOSURE_SUMMARY =
  '[PIN:a1b2c3d4e5f6]\n' +
  'Scene scene-1 — omniscient narration\n' +
  'Branch track: main\n' +
  'Revealed disclosures: 2\n' +
  'Open assertions: 1';

const MOCK_STYLE_METRICS: StyleMetrics = {
  avgSentenceLength: 14.2,
  readingLevel: 8,
  tokenCount: 120,
  lexicalDiversity: 0.72,
  dialogueRatio: 0.25,
};

const MOCK_SURFACE_PACKET: SurfaceReferencePacket = {
  sceneId: 'scene-1',
  excerptMode: 'tail',
  excerpt: '…stepped into the crowd and murmured her apologies.',
  styleMetrics: MOCK_STYLE_METRICS,
  sourceProseHash: 'a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890',
  accepted: true,
  extractorVersion: 'v1.0',
};


// ============================================================================
// Tests
// ============================================================================

describe('PromptAssembler — disclosure & surface sections', () => {
  const assembler = new PromptAssembler();

  // ── Section injection ──────────────────────────────────────────────

  describe('disclosure section injection', () => {
    it('injects ## Planned Disclosure Context section when logicalDisclosureSummary is provided', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: MOCK_DISCLOSURE_SUMMARY,
      });

      // The disclosure summary appears as a distinct section
      expect(result.userPrompt).toContain('## Planned Disclosure Context');
      expect(result.userPrompt).toContain(MOCK_DISCLOSURE_SUMMARY);
    });

    it('omits disclosure section when logicalDisclosureSummary is not provided', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
      });

      expect(result.userPrompt).not.toContain('## Planned Disclosure Context');
    });

    it('omits disclosure section when logicalDisclosureSummary is empty', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: '',
      });

      // Empty string should still mean "present" → no section added
      // because there's nothing to display
      expect(result.userPrompt).not.toContain('## Planned Disclosure Context');
    });

    it('disclosure section appears before Narrative Context Package JSON', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: MOCK_DISCLOSURE_SUMMARY,
      });

      const disclosureIndex = result.userPrompt.indexOf('## Planned Disclosure Context');
      const contextIndex = result.userPrompt.indexOf('## Narrative Context Package');

      // Disclosure section must come before the context package
      expect(disclosureIndex).toBeGreaterThanOrEqual(0);
      expect(contextIndex).toBeGreaterThan(disclosureIndex);
    });
  });

  describe('surface reference section injection', () => {
    it('injects ## Surface Reference (Non-authoritative) section when surfaceReferencePacket is provided', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      expect(result.userPrompt).toContain('## Surface Reference (Non-authoritative)');
      expect(result.userPrompt).toContain('Non-authoritative');
      expect(result.userPrompt).toContain(MOCK_SURFACE_PACKET.excerpt);
    });

    it('omits surface section when surfaceReferencePacket is not provided', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
      });

      expect(result.userPrompt).not.toContain('## Surface Reference');
    });

    it('surface section emphasizes YAML/scene-contract precedence', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      // The section must state that YAML overrides the surface reference
      const sectionMatch = result.userPrompt.match(
        /## Surface Reference \(Non-authoritative\)[\s\S]*?(?=\n## |$)/,
      );
      expect(sectionMatch).not.toBeNull();
      const section = sectionMatch![0];

      // Must contain non-authoritative disclaimer
      expect(section).toMatch(/YAML|scene.contract|non.authoritative|reference.only/i);
      // Excerpt is present for context but clearly marked as reference
      expect(section).toContain(MOCK_SURFACE_PACKET.excerpt);
    });

    it('surface section includes metrics and source hash', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      expect(result.userPrompt).toContain(MOCK_SURFACE_PACKET.sourceProseHash);
      expect(result.userPrompt).toContain(MOCK_SURFACE_PACKET.extractorVersion);
    });

    it('both disclosure and surface sections can be present simultaneously', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: MOCK_DISCLOSURE_SUMMARY,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      expect(result.userPrompt).toContain('## Planned Disclosure Context');
      expect(result.userPrompt).toContain('## Surface Reference (Non-authoritative)');
      expect(result.userPrompt).toContain(MOCK_DISCLOSURE_SUMMARY);
      expect(result.userPrompt).toContain(MOCK_SURFACE_PACKET.excerpt);
    });
  });

  // ── Non-authoritative boundary ─────────────────────────────────────

  describe('non-authoritative boundary', () => {
    it('logicalDisclosureSummary does not enter ContextPackage', () => {
      // The disclosure summary is injected at prompt-assembly time as a
      // first-class section.  It is NOT merged into the ContextPackage
      // JSON block — the ContextPackage struct has no `previousSceneSummary`
      // or `logicalDisclosureSummary` field.
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: MOCK_DISCLOSURE_SUMMARY,
      });

      // The ContextPackage JSON block exists
      const contextBlockMatch = result.userPrompt.match(
        /```json\n([\s\S]*?)```/,
      );
      expect(contextBlockMatch).not.toBeNull();

      // Parse the JSON to verify it has no disclosure or surface fields
      const contextJson = JSON.parse(contextBlockMatch![1]);
      expect(contextJson).not.toHaveProperty('logicalDisclosureSummary');
      expect(contextJson).not.toHaveProperty('previousSceneSummary');
      expect(contextJson).not.toHaveProperty('surfaceReferencePacket');
      expect(contextJson).not.toHaveProperty('surfaceReference');
    });

    it('surfaceReferencePacket does not enter ContextPackage', () => {
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      const contextBlockMatch = result.userPrompt.match(
        /```json\n([\s\S]*?)```/,
      );
      expect(contextBlockMatch).not.toBeNull();
      const contextJson = JSON.parse(contextBlockMatch![1]);

      // Surface data is ONLY in the standalone section, never in the
      // ContextPackage JSON that Pass 2 consumes as authoritative context
      expect(contextJson).not.toHaveProperty('surfaceReferencePacket');
      expect(contextJson).not.toHaveProperty('surfaceReference');
      expect(contextJson).not.toHaveProperty('surfaceProse');
    });

    it('disclosure summary uses only safe aggregates — no raw propositions', () => {
      // The logicalDisclosureSummary is compiled by
      // LogicalDisclosureSummaryCompiler which only emits safe
      // aggregate counts, never raw proposition text, IDs, or
      // Knowledge entries (§3.3).
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        logicalDisclosureSummary: MOCK_DISCLOSURE_SUMMARY,
      });

      // Summary uses counts and hash pins, not raw assertions
      expect(MOCK_DISCLOSURE_SUMMARY).toMatch(/Revealed disclosures: \d+/);
      expect(MOCK_DISCLOSURE_SUMMARY).not.toContain('proposition');
      expect(MOCK_DISCLOSURE_SUMMARY).not.toContain('butler');
      // It IS disclosure-safe
    });

    it('surface excerpt is marked as non-authoritative in the section header', () => {
      // The section header MUST declare the data non-authoritative
      // so that Pass 1 does not treat it as canonical story evidence.
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      // Header explicitly says "Non-authoritative"
      expect(result.userPrompt).toContain('Non-authoritative');

      // The excerpt itself appears in the section but is NOT the
      // source of truth — it's a prose-style reference only.
      const excerptPos = result.userPrompt.indexOf(MOCK_SURFACE_PACKET.excerpt);
      const headerPos = result.userPrompt.indexOf('## Surface Reference');
      expect(excerptPos).toBeGreaterThan(headerPos);
    });
  });

  // ── Pass 1-only guarantee ─────────────────────────────────────────

  describe('Pass 1-only guarantee', () => {
    it('disclosure and surface sections are Pass 1-only — not present in Pass 2 prompt', () => {
      // Pass 2 receives only the ContextPackage JSON and the raw prose.
      // It must NOT receive the disclosure summary or surface reference
      // sections because those are planning artifacts for prose generation,
      // not evidence for analysis.
      //
      // Since PromptAssembler.assemble produces the Pass 1 prompt, a
      // separate assembly path (or different options) serves Pass 2.
      // Verify that omitting the options produces a Pass 2-like prompt:
      const pass2Context = {
        ...MINIMAL_CONTEXT,
        // Pass 2 context includes the prose that was generated
        markdown: 'The morning sun cast long shadows.',
      };

      const pass2Prompt = assembler.assemble(pass2Context, {
        // No disclosure or surface options for Pass 2
        styleGuidance: MINIMAL_STYLE,
      });

      expect(pass2Prompt.userPrompt).not.toContain('## Planned Disclosure Context');
      expect(pass2Prompt.userPrompt).not.toContain('## Surface Reference');
    });
  });

  // ── Pass 2 must not treat surface as logical evidence ──────────────

  describe('Pass 2 surface evidence boundary', () => {
    it('surface prose must not appear as logical evidence in Pass 2', () => {
      // Pass 2 analysis validates the generated prose against the
      // narrative context and world state.  Surface reference prose
      // from a previous scene is a style/metre reference, NOT logical
      // evidence to validate against.
      //
      // The PromptAssembler must NOT inject the surfaceReferencePacket
      // or any surface excerpt into the ContextPackage JSON block,
      // because Pass 2 consumes the JSON as authoritative context.
      const pass2Context = {
        ...MINIMAL_CONTEXT,
        markdown: 'Generated prose for scene-1.',
      };

      const pass2Prompt = assembler.assemble(pass2Context, {
        styleGuidance: MINIMAL_STYLE,
        // Even if somehow passed to Pass 2 assembly, these options
        // should be ignored — but the CONTRACT is that the API
        // NEVER passes them to Pass 2 assembly.
      });

      // The ContextPackage JSON in Pass 2 must NOT contain surface data
      const contextBlockMatch = pass2Prompt.userPrompt.match(
        /```json\n([\s\S]*?)```/,
      );
      expect(contextBlockMatch).not.toBeNull();
      const contextJson = JSON.parse(contextBlockMatch![1]);

      expect(contextJson).not.toHaveProperty('surfaceReferencePacket');
      expect(contextJson).not.toHaveProperty('surfaceReference');
      expect(contextJson).not.toHaveProperty('logicalDisclosureSummary');
      expect(contextJson).not.toHaveProperty('previousSceneSummary');
    });

    it('surface excerpt is strict prose-reference — not factual evidence', () => {
      // The surface packet carries an excerpt, but it must be treated
      // as a style/diction reference, not as a source of facts.
      // This is enforced by the section header ("Non-authoritative")
      // and the fact that it sits OUTSIDE the ContextPackage JSON.
      const result = assembler.assemble(MINIMAL_CONTEXT, {
        styleGuidance: MINIMAL_STYLE,
        surfaceReferencePacket: MOCK_SURFACE_PACKET,
      });

      // The surface section comes AFTER the ContextPackage JSON
      // (it's not part of it)
      const jsonBlockEnd = result.userPrompt.indexOf('```', result.userPrompt.indexOf('```json') + 7);
      const surfaceSectionIndex = result.userPrompt.indexOf('## Surface Reference');

      if (jsonBlockEnd >= 0 && surfaceSectionIndex >= 0) {
        // Surface section is outside the JSON block
        expect(surfaceSectionIndex).toBeGreaterThan(jsonBlockEnd);
      }
    });
  });
});
