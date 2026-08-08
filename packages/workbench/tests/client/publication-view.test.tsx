import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicationView } from '../../src/client/PublicationView.js';
import type {
  BrowserPublicationListV1,
  BrowserPublicationReadResultV1,
} from '../../src/contracts/browser-api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const canonical: BrowserPublicationListV1['publications'][number] = {
  version: 1,
  projectId: 'proj-a',
  publicationId: 'canonical',
  kind: 'canonical',
  status: 'current',
  sourceHash: 'source-hash-abcdef',
  scopeHash: 'scope-hash-abcdef',
  revisionIds: ['rev-1', 'rev-2'],
  novelHash: 'novel-hash-abcdef012345',
  relativeOutputPath: 'output/novel.md',
  byteLength: 1234,
  sceneCount: 8,
  wordCount: 1200,
  staleReasons: [],
  operationId: 'op-pub-1',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

const custom: BrowserPublicationListV1['publications'][number] = {
  version: 1,
  projectId: 'proj-a',
  publicationId: 'custom-id',
  kind: 'custom',
  status: 'stale',
  sourceHash: 'old-source-hash',
  scopeHash: 'scope-hash-abcdef',
  revisionIds: ['rev-1'],
  novelHash: 'old-novel-hash',
  relativeOutputPath: 'output/custom-id.md',
  byteLength: 800,
  sceneCount: 5,
  wordCount: 600,
  staleReasons: ['source_changed', 'missing_scenes'],
  operationId: 'op-pub-2',
  createdAt: '2026-08-06T00:00:00.000Z',
  updatedAt: '2026-08-06T01:00:00.000Z',
};

const catalog: BrowserPublicationListV1 = {
  version: 1,
  projectId: 'proj-a',
  publications: [canonical, custom],
  generatedAt: '2026-08-06T02:00:00.000Z',
};

describe('Publication projections', () => {
  it('renders records with relative file names, hashes and scene identity', () => {
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        onReadPublication={async () => {
          throw new Error('unused');
        }}
      />
    ));

    expect(screen.getByRole('heading', { name: /发布记录/ })).toBeInTheDocument();
    expect(screen.getByTestId('publication-count')).toHaveTextContent('2');
    expect(screen.getByText('output/novel.md')).toBeInTheDocument();
    expect(screen.getByText('output/custom-id.md')).toBeInTheDocument();
    expect(screen.getAllByText('canonical').length).toBeGreaterThan(0);
    expect(screen.getByText('custom')).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText('source_changed')).toBeInTheDocument();
    expect(screen.getByText('missing_scenes')).toBeInTheDocument();
    expect(screen.getByText('过期原因')).toBeInTheDocument();
    // Scene/source identity surfaces as hashes, never as bytes or paths.
    expect(screen.getByText('novel-hash-a…')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('1200')).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.queryByText(/\/Users\/|\/tmp\/|C:\\/)).not.toBeInTheDocument();
  });

  it('shows an honest empty state when no publication projection is loaded', () => {
    render(() => <PublicationView projectId="proj-a" publications={null} />);

    expect(screen.getByText('暂无发布数据')).toBeInTheDocument();
    expect(screen.getByText(/打开已认证的项目/)).toBeInTheDocument();
    expect(screen.queryByTestId('publication-publish-open')).not.toBeInTheDocument();
  });

  it('shows an honest empty catalog with the publish hint', () => {
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={{ version: 1, projectId: 'proj-a', publications: [], generatedAt: 'now' }}
        onPublish={async () => undefined}
      />
    ));

    expect(screen.getByText(/还没有发布产物/)).toBeInTheDocument();
  });

  it('renders no mock data and no mutation affordances without wired callbacks', () => {
    render(() => <PublicationView projectId="proj-a" publications={catalog} />);

    expect(screen.queryByTestId('publication-publish-open')).not.toBeInTheDocument();
    expect(screen.queryByTestId('publication-download-canonical')).not.toBeInTheDocument();
    expect(screen.queryByText(/demo novel|example publication/i)).not.toBeInTheDocument();
  });

  it('shows a load-error state with a retry action when the catalog fails to load', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn(async () => undefined);
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={null}
        publicationsError="Host publication catalog request failed with HTTP 503."
        onRefresh={onRefresh}
      />
    ));

    expect(screen.getByTestId('publication-load-error')).toHaveTextContent(
      'Host publication catalog request failed with HTTP 503.',
    );
    await user.click(screen.getByTestId('publication-load-retry'));
    expect(onRefresh).toHaveBeenCalled();
  });
});

describe('Publication mutation affordances', () => {
  it('publishes the canonical novel when no branch identity is entered', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => undefined);
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="maintainer"
        onPublish={onPublish}
        onRefresh={onRefresh}
      />
    ));

    await user.click(screen.getByTestId('publication-publish-open'));
    await user.click(screen.getByTestId('publication-publish-save'));
    expect(onPublish).toHaveBeenCalledWith({ version: 1, projectId: 'proj-a' });
    expect(onRefresh).toHaveBeenCalled();
  });

  it('publishes a custom branch with the structured route identity', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(async () => undefined);
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="maintainer"
        onPublish={onPublish}
      />
    ));

    await user.click(screen.getByTestId('publication-publish-open'));
    await user.type(screen.getByTestId('publication-branch-name'), 'alternate');
    fireEvent.input(screen.getByTestId('publication-relative-path'), {
      target: { value: 'output/alternate.md' },
    });
    await user.type(screen.getByTestId('publication-title'), 'Alternate Ending');
    await user.click(screen.getByTestId('publication-publish-save'));

    expect(onPublish).toHaveBeenCalledWith({
      version: 1,
      projectId: 'proj-a',
      branchPath: { version: 1, branchPath: { decisions: [] } },
      discourseBranch: 'alternate',
      title: 'Alternate Ending',
    });
  });

  it.each([
    ['../secret.md', 'publication relative path must not traverse: ../secret.md'],
    ['/etc/passwd', 'publication relative path must not be absolute: /etc/passwd'],
    ['', 'publication relative path must not be empty'],
  ])('rejects an unsafe relative output path (%s) before publishing', async (value, expected) => {
    const user = userEvent.setup();
    const onPublish = vi.fn(async () => undefined);
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="maintainer"
        onPublish={onPublish}
      />
    ));

    await user.click(screen.getByTestId('publication-publish-open'));
    fireEvent.input(screen.getByTestId('publication-relative-path'), {
      target: { value },
    });
    await user.click(screen.getByTestId('publication-publish-save'));

    expect(screen.getByTestId('publication-mutation-error')).toHaveTextContent(expected);
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('shows a success banner once the publish request is accepted', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(async () => undefined);
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="maintainer"
        onPublish={onPublish}
      />
    ));

    await user.click(screen.getByTestId('publication-publish-open'));
    await user.click(screen.getByTestId('publication-publish-save'));

    expect(await screen.findByTestId('publication-publish-success')).toHaveTextContent(
      '发布请求已接受',
    );
  });

  it('hides the publish action for a reader session even with wired callbacks', () => {
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="reader"
        onPublish={async () => undefined}
      />
    ));

    expect(screen.queryByTestId('publication-publish-open')).not.toBeInTheDocument();
  });

  it('hides the publish action for an author session', () => {
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="author"
        onPublish={async () => undefined}
      />
    ));

    expect(screen.queryByTestId('publication-publish-open')).not.toBeInTheDocument();
  });

  it('surfaces a typed publish failure honestly', async () => {
    const user = userEvent.setup();
    const onPublish = vi.fn(async () => {
      throw new Error('Host publication request failed with HTTP 409.');
    });
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        sessionRole="maintainer"
        onPublish={onPublish}
      />
    ));

    await user.click(screen.getByTestId('publication-publish-open'));
    await user.click(screen.getByTestId('publication-publish-save'));

    expect(await screen.findByTestId('publication-mutation-error')).toHaveTextContent(
      'Host publication request failed with HTTP 409.',
    );
  });
});

describe('Publication download flow', () => {
  it('reads the artifact through the bounded read route and offers a file download', async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => 'blob:mock-url');
    const revokeObjectURL = vi.fn();
    const click = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);

    const queries: Array<{ offset: number; limit: number }> = [];
    const onRead = async (
      _projectId: string,
      _publicationId: string,
      query?: { offset?: number; limit?: number },
    ): Promise<BrowserPublicationReadResultV1> => {
      const offset = query?.offset ?? 0;
      queries.push({ offset, limit: query?.limit ?? 0 });
      return {
        version: 1,
        projectId: 'proj-a',
        publicationId: 'canonical',
        offset,
        limit: 262144,
        content: offset === 0 ? '# Chapter One\n' : 'It was a dark night.\n',
        // The record's byteLength is 1234; page to the end in two slices.
        byteLength: offset === 0 ? 1000 : 234,
        totalByteLength: 1234,
      };
    };

    render(() => (
      <PublicationView projectId="proj-a" publications={catalog} onReadPublication={onRead} />
    ));

    await user.click(screen.getByTestId('publication-download-canonical'));

    expect(queries).toEqual([
      { offset: 0, limit: 262144 },
      { offset: 1000, limit: 262144 },
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });

  it('reports a read failure honestly without inventing a file', async () => {
    const user = userEvent.setup();
    render(() => (
      <PublicationView
        projectId="proj-a"
        publications={catalog}
        onReadPublication={async () => {
          throw new Error('Host publication request failed with HTTP 503.');
        }}
      />
    ));

    await user.click(screen.getByTestId('publication-download-canonical'));

    expect(await screen.findByTestId('publication-mutation-error')).toHaveTextContent(
      'Host publication request failed with HTTP 503.',
    );
  });
});
