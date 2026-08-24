import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  allowOrganizationPermissions as allow,
  authClientStub,
  resetAuthClientStub,
} from '@/test/auth-client-stub';
import { context, organization } from '@/test/organization-fixtures';
import { renderInOrganization } from '@/test/render';

vi.mock('@/features/auth/auth-client', async () => {
  const { authClientStub } = await import('@/test/auth-client-stub');

  return { authClient: authClientStub };
});

/**
 * The API module is mocked, not `fetch`. `organization-api` reaches the
 * network through `application-api`, which is asserted elsewhere to be the
 * only `fetch` call site, so stubbing it is stubbing the boundary. What these
 * tests are about is the operator's screen.
 */
const listKnowledgeSpaces = vi.fn();
const clearKnowledgeSpace = vi.fn();
const listKnowledgeDocuments = vi.fn();
const ingestKnowledgeDocument = vi.fn();
const deleteKnowledgeDocument = vi.fn();

vi.mock('../organization-api', async () => {
  const actual = await vi.importActual<typeof import('../organization-api')>(
    '../organization-api',
  );

  return {
    ...actual,
    listKnowledgeSpaces: (...args: unknown[]) => listKnowledgeSpaces(...args),
    clearKnowledgeSpace: (...args: unknown[]) => clearKnowledgeSpace(...args),
    listKnowledgeDocuments: (...args: unknown[]) =>
      listKnowledgeDocuments(...args),
    ingestKnowledgeDocument: (...args: unknown[]) =>
      ingestKnowledgeDocument(...args),
    deleteKnowledgeDocument: (...args: unknown[]) =>
      deleteKnowledgeDocument(...args),
  };
});

const { OrganizationKnowledgeBlock } =
  await import('./organization-knowledge-block');
const { ApiError, ApiUnavailableError } = await import('@/lib/application-api');

/**
 * A registry entry, not a row somebody created.
 *
 * The taxonomy is the application's: the same eight spaces exist for every
 * organization, `configured` says whether this one has stored anything in it,
 * and there is no id on the surface at all.
 */
const space = (overrides: Record<string, unknown> = {}) => ({
  slug: 'brand.voice',
  name: 'Brand voice',
  description: 'Tone, vocabulary, and how the brand writes.',
  configured: true,
  documentCount: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...overrides,
});

/** One page of documents, which is what the listing now answers with. */
const page = (items: unknown[], nextCursor: string | null = null) => ({
  items,
  nextCursor,
});

const document = (overrides: Record<string, unknown> = {}) => ({
  id: 'doc_policies',
  title: 'Policies',
  sourceUri: null,
  checksum: 'abc',
  revision: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
  _count: { chunks: 4 },
  ...overrides,
});

const render = () =>
  renderInOrganization(
    <OrganizationKnowledgeBlock />,
    context({ organization: organization() }),
  );

beforeEach(() => {
  resetAuthClientStub();
  vi.clearAllMocks();

  listKnowledgeSpaces.mockResolvedValue([space()]);
  listKnowledgeDocuments.mockResolvedValue(page([document()]));
});

describe('the knowledge screen', () => {
  it('lists the spaces and the documents in the first one', async () => {
    allow('knowledge:read');

    render();

    expect(await screen.findByText('Brand voice')).toBeInTheDocument();
    expect(await screen.findByText('Policies')).toBeInTheDocument();
  });

  /**
   * The name comes from this application's dictionary, keyed on the slug — not
   * from the `name` column the server happens to return.
   *
   * An operator reading Arabic should not be shown an English taxonomy, and
   * the server has only one name per space. The canary is a name no dictionary
   * contains: if it reaches the screen, the translation was bypassed.
   */
  it('names a space from the reader dictionary, not from the server', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([
      space({ name: 'SERVER-SUPPLIED-NAME' }),
    ]);

    render();

    expect(await screen.findByText('Brand voice')).toBeInTheDocument();
    expect(
      screen.queryByText('SERVER-SUPPLIED-NAME'),
    ).not.toBeInTheDocument();
  });

  /**
   * The failure this guards is only visible when the two differ, so the stub
   * is given a *different* active organization. With no active organization
   * at all the assertion passes whichever id the block reads.
   */
  it('asks for the organization in hand, not the active one', async () => {
    allow('knowledge:read');
    authClientStub.useActiveOrganization.mockReturnValue({
      data: { id: 'org_elsewhere', name: 'Elsewhere' },
      isPending: false,
    });

    render();

    await screen.findByText('Brand voice');

    expect(listKnowledgeSpaces).toHaveBeenCalledWith(
      organization().id,
      expect.any(AbortSignal),
    );
    expect(listKnowledgeSpaces).not.toHaveBeenCalledWith(
      'org_elsewhere',
      expect.any(AbortSignal),
    );
  });

  /**
   * A disabled feature and a missing permission are both 403. Telling an owner
   * who holds every grant that they lack permission sends them to change roles
   * over something no role can fix.
   */
  it('says the feature is off rather than blaming permissions', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockRejectedValue(
      new ApiError(403, 'FEATURE_DISABLED'),
    );

    render();

    await userEvent.type(await screen.findByLabelText(/^title$/i), 'Policies');
    await userEvent.type(screen.getByLabelText(/^text$/i), 'Some text.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    expect(await screen.findByText(/switched off/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/do not have permission/i),
    ).not.toBeInTheDocument();
  });

  it('still blames permissions for an ordinary refusal', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockRejectedValue(new ApiError(403, 'FORBIDDEN'));

    render();

    await userEvent.type(await screen.findByLabelText(/^title$/i), 'Policies');
    await userEvent.type(screen.getByLabelText(/^text$/i), 'Some text.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    expect(
      await screen.findByText(/do not have permission/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/switched off/i)).not.toBeInTheDocument();
  });

  /**
   * A reader without write is not shown controls that would answer 403. The
   * gate is UX; the backend decides.
   */
  it('offers a reader nothing to change', async () => {
    allow('knowledge:read');

    render();

    await screen.findByText('Brand voice');

    expect(
      screen.queryByRole('button', { name: /delete everything/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /store document/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^text$/i)).not.toBeInTheDocument();
  });

  it('offers a writer the controls', async () => {
    allow('knowledge:read', 'knowledge:write');

    render();

    expect(
      await screen.findByRole('button', { name: /store document/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /delete everything/i }),
    ).toBeInTheDocument();
  });

  /**
   * The taxonomy is code-owned, so there is nothing to create and no field to
   * type a slug into. This is the property the redesign rests on: a customer
   * cannot invent a space, which is what stops an agent's context policy from
   * silently naming one nobody uses.
   */
  it('offers no way to invent a space', async () => {
    allow('knowledge:read', 'knowledge:write');

    render();

    await screen.findByText('Brand voice');

    expect(
      screen.queryByRole('button', { name: /create space/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/slug/i)).not.toBeInTheDocument();
  });

  /**
   * Every registry entry is offered, including the ones this organization has
   * never written to — the listing is the taxonomy, and what varies is the
   * count beside each.
   */
  it('shows every space, including the empty ones', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([
      space(),
      space({
        slug: 'faq',
        name: 'FAQ',
        configured: false,
        documentCount: 0,
      }),
    ]);

    render();

    expect(await screen.findByText('Brand voice')).toBeInTheDocument();
    expect(screen.getByText('FAQ')).toBeInTheDocument();
  });

  it('stores a document in the selected space', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockResolvedValue({
      id: 'doc_new',
      title: 'Returns',
      revision: 1,
      chunkCount: 2,
      changed: true,
    });

    render();

    await userEvent.type(await screen.findByLabelText(/^title$/i), 'Returns');
    await userEvent.type(screen.getByLabelText(/^text$/i), 'Sixty days.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    await waitFor(() =>
      expect(ingestKnowledgeDocument).toHaveBeenCalledWith(
        organization().id,
        'brand.voice',
        { title: 'Returns', content: 'Sixty days.' },
      ),
    );
  });

  /**
   * A refused document is usually refused for something the operator can fix.
   * Emptying a textarea they have just pasted into is the worst possible
   * answer to a correctable error.
   */
  it('keeps a refused document in the field so it can be corrected', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockRejectedValue(
      new ApiError(400, 'VALIDATION_ERROR', {
        reason: 'The document is 900000 bytes and the limit is 1048576.',
      }),
    );

    render();

    const title = await screen.findByLabelText(/^title$/i);
    const text = screen.getByLabelText(/^text$/i);

    await userEvent.type(title, 'Returns');
    await userEvent.type(text, 'Sixty days.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    await screen.findByText(/900000 bytes/i);
    expect(text).toHaveValue('Sixty days.');
    expect(title).toHaveValue('Returns');
  });

  it('clears the field once the document is stored', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockResolvedValue({
      id: 'doc_new',
      title: 'Returns',
      revision: 1,
      chunkCount: 2,
      changed: true,
    });

    render();

    const text = await screen.findByLabelText(/^text$/i);
    await userEvent.type(screen.getByLabelText(/^title$/i), 'Returns');
    await userEvent.type(text, 'Sixty days.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    await waitFor(() => expect(text).toHaveValue(''));
  });

  it('deletes the document the operator pointed at', async () => {
    allow('knowledge:read', 'knowledge:write');
    deleteKnowledgeDocument.mockResolvedValue({ id: 'doc_policies' });

    render();

    await userEvent.click(
      await screen.findByRole('button', { name: /delete policies/i }),
    );

    await waitFor(() =>
      expect(deleteKnowledgeDocument).toHaveBeenCalledWith(
        organization().id,
        'doc_policies',
      ),
    );
  });

  it('empties the selected space by slug', async () => {
    allow('knowledge:read', 'knowledge:write');
    clearKnowledgeSpace.mockResolvedValue({ slug: 'brand.voice' });

    render();

    await userEvent.click(
      await screen.findByRole('button', { name: /delete everything in brand voice/i }),
    );

    await waitFor(() =>
      expect(clearKnowledgeSpace).toHaveBeenCalledWith(
        organization().id,
        'brand.voice',
      ),
    );
  });

  /**
   * Emptying a space that holds nothing is not an operation, so the control is
   * absent rather than present and answering 404.
   */
  it('offers no way to empty a space that holds nothing', async () => {
    allow('knowledge:read', 'knowledge:write');
    listKnowledgeSpaces.mockResolvedValue([
      space({ configured: false, documentCount: 0 }),
    ]);

    render();

    await screen.findByText('Brand voice');

    expect(
      screen.queryByRole('button', { name: /delete everything/i }),
    ).not.toBeInTheDocument();
  });

  it('switches the document list when another space is chosen', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([
      space(),
      space({ slug: 'products.services', configured: false, documentCount: 0 }),
    ]);

    render();

    await userEvent.click(
      await screen.findByRole('button', { name: /products and services/i }),
    );

    await waitFor(() =>
      expect(listKnowledgeDocuments).toHaveBeenLastCalledWith(
        organization().id,
        'products.services',
        { signal: expect.any(AbortSignal) },
      ),
    );
  });

  /**
   * The rows and the chosen space arrive independently, so a list that is not
   * tied to a space renders whichever landed last. Showing the previous
   * space's documents under the new space's heading tells an operator that
   * content lives somewhere it does not.
   */
  it('shows no documents for a space whose own rows have not arrived', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([
      space(),
      space({ slug: 'products.services', configured: false, documentCount: 0 }),
    ]);
    listKnowledgeDocuments.mockImplementation((_organizationId, slug) =>
      slug === 'brand.voice'
        ? Promise.resolve(page([document()]))
        : new Promise(() => {}),
    );

    render();

    expect(await screen.findByText('Policies')).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole('button', { name: /products and services/i }),
    );

    await waitFor(() =>
      expect(screen.queryByText('Policies')).not.toBeInTheDocument(),
    );
  });

  it('says the API could not be reached, distinctly from a refusal', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockRejectedValue(
      new ApiUnavailableError(new TypeError('Failed to fetch')),
    );

    render();

    await screen.findByText(/could not be reached/i);
  });

  it('says the session expired rather than blaming a missing role', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED'));

    render();

    await screen.findByText(/session has expired/i);
    expect(
      screen.queryByText(/do not have permission/i),
    ).not.toBeInTheDocument();
  });

  it('reports a refusal from the server', async () => {
    allow('knowledge:read', 'knowledge:write');
    ingestKnowledgeDocument.mockRejectedValue(new ApiError(409, 'CONFLICT'));

    render();

    await userEvent.type(await screen.findByLabelText(/^title$/i), 'Policies');
    await userEvent.type(screen.getByLabelText(/^text$/i), 'Some text.');
    await userEvent.click(
      screen.getByRole('button', { name: /store document/i }),
    );

    await screen.findByText(/could not be stored/i);
  });

  /**
   * Paging, which replaced a silent two-hundred-row ceiling. The old listing
   * stopped without saying so, and a client had no way to tell a space with
   * exactly two hundred documents from one with a thousand.
   */
  describe('paging through documents', () => {
    it('offers no control when the page is the whole collection', async () => {
      allow('knowledge:read');

      render();

      await screen.findByText('Policies');

      expect(
        screen.queryByRole('button', { name: /load more/i }),
      ).not.toBeInTheDocument();
    });

    it('appends the next page rather than replacing the list', async () => {
      allow('knowledge:read');
      listKnowledgeDocuments
        .mockResolvedValueOnce(page([document()], 'cursor-1'))
        .mockResolvedValueOnce(
          page([document({ id: 'doc_returns', title: 'Returns' })]),
        );

      render();

      await userEvent.click(
        await screen.findByRole('button', { name: /load more/i }),
      );

      expect(await screen.findByText('Returns')).toBeInTheDocument();
      // The first page is still there; this is a longer list, not a new one.
      expect(screen.getByText('Policies')).toBeInTheDocument();

      expect(listKnowledgeDocuments).toHaveBeenLastCalledWith(
        organization().id,
        'brand.voice',
        { cursor: 'cursor-1' },
      );
    });

    it('stops offering more once the last page has arrived', async () => {
      allow('knowledge:read');
      listKnowledgeDocuments
        .mockResolvedValueOnce(page([document()], 'cursor-1'))
        .mockResolvedValueOnce(
          page([document({ id: 'doc_returns', title: 'Returns' })]),
        );

      render();

      await userEvent.click(
        await screen.findByRole('button', { name: /load more/i }),
      );

      await screen.findByText('Returns');
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /load more/i }),
        ).not.toBeInTheDocument(),
      );
    });

    /**
     * A cursor is a position in one space's ordering and means nothing in
     * another's. Switching spaces has to discard it, or the next page pages
     * the wrong collection.
     */
    it('does not carry a cursor across to another space', async () => {
      allow('knowledge:read');
      listKnowledgeSpaces.mockResolvedValue([
        space(),
        space({ slug: 'faq', configured: false, documentCount: 0 }),
      ]);
      listKnowledgeDocuments.mockResolvedValue(page([document()], 'cursor-1'));

      render();

      await screen.findByRole('button', { name: /load more/i });

      await userEvent.click(screen.getByRole('button', { name: /faq/i }));

      await waitFor(() =>
        expect(listKnowledgeDocuments).toHaveBeenLastCalledWith(
          organization().id,
          'faq',
          { signal: expect.any(AbortSignal) },
        ),
      );
    });
  });
});
