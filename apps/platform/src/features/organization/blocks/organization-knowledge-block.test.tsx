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
const createKnowledgeSpace = vi.fn();
const deleteKnowledgeSpace = vi.fn();
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
    createKnowledgeSpace: (...args: unknown[]) => createKnowledgeSpace(...args),
    deleteKnowledgeSpace: (...args: unknown[]) => deleteKnowledgeSpace(...args),
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

const space = (overrides: Record<string, unknown> = {}) => ({
  id: 'space_brand',
  slug: 'brand',
  name: 'Brand',
  documentCount: 1,
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  ...overrides,
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
  listKnowledgeDocuments.mockResolvedValue([document()]);
});

describe('the knowledge screen', () => {
  it('lists the spaces and the documents in the first one', async () => {
    allow('knowledge:read');

    render();

    expect(await screen.findByText('Brand')).toBeInTheDocument();
    expect(await screen.findByText('Policies')).toBeInTheDocument();
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

    await screen.findByText('Brand');

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

    await screen.findByText('Brand');

    expect(
      screen.queryByRole('button', { name: /create space/i }),
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
      await screen.findByRole('button', { name: /create space/i }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: /store document/i }),
    ).toBeInTheDocument();
  });

  it('creates a space from what was typed', async () => {
    allow('knowledge:read', 'knowledge:write');
    createKnowledgeSpace.mockResolvedValue(space({ id: 'space_product' }));

    render();

    await userEvent.type(await screen.findByLabelText(/slug/i), 'product');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Product');
    await userEvent.click(
      screen.getByRole('button', { name: /create space/i }),
    );

    await waitFor(() =>
      expect(createKnowledgeSpace).toHaveBeenCalledWith(organization().id, {
        slug: 'product',
        name: 'Product',
      }),
    );
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
        'space_brand',
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

  it('deletes the selected space', async () => {
    allow('knowledge:read', 'knowledge:write');
    deleteKnowledgeSpace.mockResolvedValue({ id: 'space_brand' });

    render();

    await userEvent.click(
      await screen.findByRole('button', { name: /delete brand/i }),
    );

    await waitFor(() =>
      expect(deleteKnowledgeSpace).toHaveBeenCalledWith(
        organization().id,
        'space_brand',
      ),
    );
  });

  it('switches the document list when another space is chosen', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([
      space(),
      space({ id: 'space_product', slug: 'product', name: 'Product' }),
    ]);

    render();

    await userEvent.click(
      await screen.findByRole('button', { name: /product/i }),
    );

    await waitFor(() =>
      expect(listKnowledgeDocuments).toHaveBeenLastCalledWith(
        organization().id,
        'space_product',
        expect.any(AbortSignal),
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
      space({ id: 'space_product', slug: 'product', name: 'Product' }),
    ]);
    listKnowledgeDocuments.mockImplementation((_organizationId, spaceId) =>
      spaceId === 'space_brand'
        ? Promise.resolve([document()])
        : new Promise(() => {}),
    );

    render();

    expect(await screen.findByText('Policies')).toBeInTheDocument();

    await userEvent.click(
      await screen.findByRole('button', { name: /product/i }),
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
    createKnowledgeSpace.mockRejectedValue(new ApiError(409, 'CONFLICT'));

    render();

    await userEvent.type(await screen.findByLabelText(/slug/i), 'brand');
    await userEvent.type(screen.getByLabelText(/^name$/i), 'Brand');
    await userEvent.click(
      screen.getByRole('button', { name: /create space/i }),
    );

    await screen.findByText(/could not be stored/i);
  });

  it('says so when an organization has no spaces yet', async () => {
    allow('knowledge:read');
    listKnowledgeSpaces.mockResolvedValue([]);

    render();

    expect(await screen.findByText(/no spaces yet/i)).toBeInTheDocument();
    expect(listKnowledgeDocuments).not.toHaveBeenCalled();
  });
});
