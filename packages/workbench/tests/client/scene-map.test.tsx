import { cleanup, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { SceneMap } from '../../src/client/SceneMap';
import type {
  SceneDetailViewV1,
  SceneMapViewV1,
  SceneSummaryRowV1,
} from '../../src/contracts/index.js';

const mocks = vi.hoisted(() => ({
  replaceWorkingDocumentText: vi.fn(),
}));

vi.mock('../../src/client/yjs-editor.js', () => ({
  replaceWorkingDocumentText: mocks.replaceWorkingDocumentText,
}));

afterEach(() => {
  cleanup();
  mocks.replaceWorkingDocumentText.mockReset();
});

const E1_YAML = [
  'event: E1',
  'narrativeOrder: 1',
  'title: Encounter',
  'pov: { character: narrator, type: first_person }',
  'storyTime: day_1',
  'sceneType: linear',
  'discourseMode: action',
  'emotionalValence: tension',
  'sceneBrief: A test scene.',
  'beats:',
  '  - A test scene.',
  'preconditions: []',
  'expectedPostconditions: []',
  '',
].join('\n');

function row(
  eventId: string,
  title: string,
  sceneType: string,
  storyTime: string,
): SceneSummaryRowV1 {
  return {
    eventId,
    title,
    sceneType,
    discourseMode: null,
    storyTime,
    coordinate: { chapter: 1, narrativeOrder: 1 },
    changedCount: 1,
    introCount: 0,
    renderStatus: 'unadopted',
    stale: false,
    adoptedSceneHash: null,
    currentSceneHash: null,
    proseHash: null,
    revisionId: null,
  };
}

const map: SceneMapViewV1 = {
  version: 1,
  projectId: 'proj-scenes',
  chapters: [
    {
      chapterId: 'chapter_01',
      chapter: 1,
      title: 'Opening',
      summary: '',
      plannedScenes: 1,
      scenes: [row('E1', 'Encounter', 'linear', 'day_1'), row('E2', 'Dialogue', 'linear', 'day_2')],
    },
  ],
  strips: { threadProgress: [], emotionalValence: [], greyLines: [] },
  generatedAt: '2026-08-08T00:00:00.000Z',
};

function detailFor(eventId: string, eventYaml: string): SceneDetailViewV1 {
  return {
    version: 1,
    projectId: 'proj-scenes',
    eventId,
    diff: { before: {}, after: {}, changed: [] },
    entities: [],
    graphEdges: [],
    hashes: {
      stateBeforeHash: 'a'.repeat(64),
      stateAfterHash: 'a'.repeat(64),
      worldStateHash: 'a'.repeat(64),
      knowledgeStateHash: 'a'.repeat(64),
      narratorProfileHash: 'a'.repeat(64),
      discourseHash: 'a'.repeat(64),
      sourceHash: 'a'.repeat(64),
      sceneHash: null,
      proseHash: null,
    },
    discourse: { ledgerId: null, discourseMode: null, discoursePosition: null, assertions: [] },
    renderStatus: 'unadopted',
    stale: false,
    adoptedSceneHash: null,
    eventYaml,
    eventDocumentId: eventYaml === null ? null : `chapters/chapter_01/${eventId}.yaml`,
  };
}

describe('SceneMap scene card editor (plan Step 5)', () => {
  it('renders the inline edit form, prefills from the working event YAML, and saves a merged document through the Yjs write path', async () => {
    mocks.replaceWorkingDocumentText.mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSelectScene = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(() => (
      <SceneMap
        projectId="proj-scenes"
        map={map}
        detail={detailFor('E1', E1_YAML)}
        sourceSessionId="session-1"
        onRefresh={onRefresh}
        onSelectScene={onSelectScene}
      />
    ));

    // The row exposes the edit entry.
    await user.click(screen.getByRole('button', { name: '编辑 E1' }));

    // The form is inline and prefilled from the working event YAML.
    const title = screen.getByLabelText('标题 E1') as HTMLInputElement;
    expect(title.value).toBe('Encounter');
    const body = screen.getByLabelText('正文 E1') as HTMLTextAreaElement;
    expect(body.value).toContain('A test scene.');
    const valence = screen.getByLabelText('情绪 E1') as HTMLSelectElement;
    expect(valence.value).toBe('tension');
    const sceneType = screen.getByLabelText('场景类型 E1') as HTMLSelectElement;
    expect(sceneType.value).toBe('linear');

    // Edit two of the six fields; the rest stay untouched.
    await user.clear(title);
    await user.type(title, 'Encounter at dusk');
    await user.selectOptions(valence, 'hopeful_earnest');

    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mocks.replaceWorkingDocumentText).toHaveBeenCalledTimes(1);
    const write = mocks.replaceWorkingDocumentText.mock.calls[0]?.[0] as {
      projectId: string;
      documentId: string;
      sessionId: string;
      text: string;
    };
    expect(write.projectId).toBe('proj-scenes');
    expect(write.documentId).toBe('chapters/chapter_01/E1.yaml');
    expect(write.sessionId).toBe('session-1');

    // The writeback text is the merged event YAML: edited fields updated,
    // untouched fields (pov, narrativeOrder, sceneBrief, beats) preserved.
    const merged = YAML.parse(write.text) as Record<string, unknown>;
    expect(merged.title).toBe('Encounter at dusk');
    expect(merged.emotionalValence).toBe('hopeful_earnest');
    expect(merged.pov).toEqual({ character: 'narrator', type: 'first_person' });
    expect(merged.narrativeOrder).toBe(1);
    expect(merged.sceneBrief).toBe('A test scene.');
    expect(merged.beats).toEqual(['A test scene.']);
    expect(merged.event).toBe('E1');

    // The map and detail refresh after a successful save.
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onSelectScene).toHaveBeenCalledWith('E1');
  });

  it('blocks saving without a working event document', async () => {
    mocks.replaceWorkingDocumentText.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(() => (
      <SceneMap
        projectId="proj-scenes"
        map={map}
        detail={detailFor('E1', '')}
        sourceSessionId="session-1"
      />
    ));

    await user.click(screen.getByRole('button', { name: '编辑 E1' }));
    await user.click(screen.getByRole('button', { name: '保存' }));

    expect(mocks.replaceWorkingDocumentText).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/工作区文档/);
  });
});
