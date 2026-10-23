import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlyphEditorAnnotationMarker } from '#code-oss/ui/GlyphAnnotations/GlyphEditorAnnotationMarker.tsx';

afterEach(cleanup);

describe(GlyphEditorAnnotationMarker, () => {
  it('reopens an annotation from the editor gutter without moving focus', () => {
    const open = vi.fn();
    render(<GlyphEditorAnnotationMarker order={4} comment="Rename this" open={open} />);

    const marker = screen.getByRole('button', { name: 'Edit annotation 4' });
    expect(marker.title).toBe('Rename this');
    expect(fireEvent.mouseDown(marker)).toBe(false);
    fireEvent.click(marker);

    expect(open).toHaveBeenCalledOnce();
  });
});
