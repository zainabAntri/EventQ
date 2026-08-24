import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Alert, Button, FormField, Input, Label } from './index';

/**
 * These assert BEHAVIOUR and ACCESSIBILITY, not markup.
 *
 * Snapshot tests on a design system fail on every visual tweak and pass on
 * every accessibility regression — precisely backwards. Queries here go through
 * the accessibility tree (getByRole, getByLabelText), so a test can only pass
 * if a screen-reader user could also find the element.
 */

describe('Button', () => {
  it('is reachable and activatable by keyboard alone', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Approve</Button>);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus();

    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('announces its busy state and blocks activation while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button isLoading loadingLabel="Approving" onClick={onClick}>
        Approve
      </Button>,
    );

    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Approving')).toBeInTheDocument();

    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps focus while loading', async () => {
    // The reason aria-disabled is used instead of `disabled`: a disabled element
    // loses focus, dumping a keyboard user back to the top of the document in
    // the middle of their task.
    const user = userEvent.setup();
    render(<Button isLoading>Approve</Button>);

    await user.tab();
    expect(screen.getByRole('button')).toHaveFocus();
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(<Button>Approve</Button>);
    await expect(container).toHaveNoSeriousA11yViolations();
  });
});

describe('FormField', () => {
  it('associates the label with its control', () => {
    render(
      <FormField>
        <Label>Your question</Label>
        <Input />
      </FormField>,
    );

    // Only passes if htmlFor/id are wired — the exact thing that silently rots.
    expect(screen.getByLabelText('Your question')).toBeInTheDocument();
  });

  it('links hint and error into aria-describedby, in reading order', () => {
    render(
      <FormField hint="Keep it under 500 characters" error="Question is too short">
        <Label>Your question</Label>
        <Input />
      </FormField>,
    );

    const input = screen.getByLabelText('Your question');
    const describedBy = input.getAttribute('aria-describedby')?.split(' ') ?? [];

    expect(describedBy).toHaveLength(2);
    const described = describedBy.map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(['Keep it under 500 characters', 'Question is too short']);
  });

  it('marks the control invalid only when there is an error', () => {
    const { rerender } = render(
      <FormField>
        <Label>Your question</Label>
        <Input />
      </FormField>,
    );
    expect(screen.getByLabelText('Your question')).not.toHaveAttribute('aria-invalid');

    rerender(
      <FormField error="Too short">
        <Label>Your question</Label>
        <Input />
      </FormField>,
    );
    expect(screen.getByLabelText('Your question')).toHaveAttribute('aria-invalid', 'true');
  });

  it('renders the error region before it has content so the first error is announced', () => {
    render(
      <FormField>
        <Label>Your question</Label>
        <Input />
      </FormField>,
    );

    // A live region inserted at the same moment as its text is widely ignored
    // by assistive tech, so the empty region must already exist.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('communicates required state to assistive tech, not just visually', () => {
    render(
      <FormField>
        <Label requiredMarker>Your question</Label>
        <Input required />
      </FormField>,
    );

    expect(screen.getByText('(required)')).toBeInTheDocument();
    expect(screen.getByLabelText(/Your question/)).toBeRequired();
  });

  it('fails loudly when a control is used outside FormField', () => {
    // A silent failure here would mean an unlabelled input reaching production.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Input />)).toThrow(/must be rendered inside <FormField>/);
    spy.mockRestore();
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(
      <FormField hint="Be specific" error="Too short">
        <Label requiredMarker>Your question</Label>
        <Input />
      </FormField>,
    );
    await expect(container).toHaveNoSeriousA11yViolations();
  });
});

describe('Alert', () => {
  it('interrupts for errors and stays polite otherwise', () => {
    const { rerender } = render(<Alert severity="error">Submission failed</Alert>);
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');

    rerender(<Alert severity="info">Question submitted</Alert>);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('has no serious accessibility violations', async () => {
    const { container } = render(
      <Alert severity="error" title="Could not submit">
        Please try again.
      </Alert>,
    );
    await expect(container).toHaveNoSeriousA11yViolations();
  });
});
