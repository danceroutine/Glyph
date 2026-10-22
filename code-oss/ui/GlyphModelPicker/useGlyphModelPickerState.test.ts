import { act, renderHook } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { GlyphWorkbenchStatus, type GlyphWorkbenchState } from '#src/desktop/workbench/GlyphWorkbenchState.js';
import type { GlyphWorkbenchViewActions } from '#src/desktop/workbench/GlyphWorkbenchView.js';
import type { GlyphChatSummary } from '#src/desktop/protocol/events/GlyphChatSummary.js';
import { useGlyphModelPickerState } from '#code-oss/ui/GlyphModelPicker/useGlyphModelPickerState.ts';

const workbench = (overrides: Partial<GlyphWorkbenchState> = {}): GlyphWorkbenchState => ({
  status: GlyphWorkbenchStatus.READY,
  transcript: [],
  usage: {},
  accounts: [],
  models: [],
  chats: [],
  runs: [],
  proposals: [],
  ownerWindowId: 'window',
  readOnly: false,
  sequence: 0,
  ...overrides,
});

const chat = (overrides: Partial<GlyphChatSummary> = {}): GlyphChatSummary => ({
  id: 'chat',
  title: 'Chat',
  accountProvider: 'openai',
  accountId: 'account',
  modelSlug: 'gpt-5',
  updatedAt: '2026-01-01T00:00:00.000Z',
  turnCount: 1,
  ...overrides,
});

const actions = (selectModel = vi.fn(async (_model: string) => {})) =>
  ({ selectModel }) as unknown as GlyphWorkbenchViewActions;

describe(useGlyphModelPickerState, () => {
  it('offers every model for a new chat with the selected model chosen', () => {
    const state = workbench({
      models: [
        { slug: 'gpt-5', name: 'GPT-5' },
        { slug: 'o3', name: 'o3' },
      ],
      selectedModel: 'o3',
    });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.model).toBe('o3');
    expect(result.current.label).toBe('o3');
    expect(result.current.disabled).toBe(false);
    expect(result.current.models).toEqual([
      { value: 'gpt-5', label: 'GPT-5' },
      { value: 'o3', label: 'o3' },
    ]);
  });

  it('locks an existing chat to the model it was started with', () => {
    const state = workbench({
      chats: [chat({ id: 'open', modelSlug: 'gpt-5' })],
      selectedChatId: 'open',
      models: [{ slug: 'gpt-5', name: 'GPT-5' }],
      selectedModel: 'o3',
    });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.model).toBe('gpt-5');
    expect(result.current.label).toBe('GPT-5');
    expect(result.current.disabled).toBe(true);
    expect(result.current.models).toEqual([{ value: 'gpt-5', label: 'GPT-5' }]);
  });

  it('names an existing chat model by its identifier when it is no longer in the catalog', () => {
    const state = workbench({
      chats: [chat({ id: 'open', modelSlug: 'retired' })],
      selectedChatId: 'open',
      models: [{ slug: 'gpt-5', name: 'GPT-5' }],
    });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.label).toBe('retired');
    expect(result.current.models).toEqual([{ value: 'retired', label: 'retired' }]);
  });

  it('shows a loading placeholder while the catalog is pending', () => {
    const state = workbench({ catalogPending: true });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.model).toBe('');
    expect(result.current.label).toBe('Loading models…');
    expect(result.current.disabled).toBe(true);
    expect(result.current.models).toEqual([{ value: '', label: 'Loading models…' }]);
  });

  it('shows an unavailable placeholder when no model can be chosen', () => {
    const state = workbench({ models: [{ slug: 'gpt-5', name: 'GPT-5' }] });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.label).toBe('No model available');
    expect(result.current.models).toEqual([
      { value: '', label: 'No model available' },
      { value: 'gpt-5', label: 'GPT-5' },
    ]);
  });

  it.each([
    ['navigation is pending', { navigationPending: true }],
    ['the catalog is empty', { models: [] }],
    ['the window is read-only', { readOnly: true }],
  ])('is disabled while %s', (_, overrides) => {
    const state = workbench({ models: [{ slug: 'gpt-5', name: 'GPT-5' }], ...overrides });

    const { result } = renderHook(useGlyphModelPickerState, { initialProps: { state, actions: actions() } });

    expect(result.current.disabled).toBe(true);
  });

  it('asks the host to select the chosen model and ignores failures', async () => {
    const selectModel = vi.fn(async (_model: string) => {
      throw new Error('offline');
    });
    const state = workbench({ models: [{ slug: 'gpt-5', name: 'GPT-5' }] });
    const { result } = renderHook(useGlyphModelPickerState, {
      initialProps: { state, actions: actions(selectModel) },
    });

    await act(async () => {
      result.current.selectModel('gpt-5');
    });

    expect(selectModel).toHaveBeenCalledWith('gpt-5');
  });
});
