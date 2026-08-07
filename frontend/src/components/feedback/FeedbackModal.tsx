import { useState } from 'react';
import { useLocation } from 'react-router';
import axios from 'axios';
import { toast } from 'sonner';
import { Star } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useFeedback } from '@/hooks/useFeedback';
import { MAX_RATING } from '@/types/feedback';

interface FeedbackModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STAR_VALUES = Array.from({ length: MAX_RATING }, (_, i) => i + 1);

function getErrorMessage(error: Error): string {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 429) {
      return "You've sent a lot of feedback recently. Please try again later.";
    }
    if (status === 422) {
      return 'Feedback is too long. Please shorten it and try again.';
    }
  }
  return "Couldn't send your feedback. Something went wrong. Please try again in a moment.";
}

export function FeedbackModal({ open, onOpenChange }: FeedbackModalProps) {
  const loc = useLocation();
  const [text, setText] = useState('');
  const [rating, setRating] = useState<number | undefined>(undefined);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { mutate, isPending } = useFeedback();

  // Cumulative star rating: click star N sets rating N; click the current rating again clears it.
  const handleStarClick = (value: number) => {
    setRating(prev => (prev === value ? undefined : value));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;

    const page_url = loc.pathname + loc.search;

    setSubmitError(null);
    mutate(
      { text: text.trim(), rating, page_url },
      {
        onSuccess: () => {
          toast('Thanks for the feedback!');
          onOpenChange(false);
          setText('');
          setRating(undefined);
        },
        onError: (error) => {
          setSubmitError(getErrorMessage(error));
        },
      },
    );
  };

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setText('');
      setRating(undefined);
      setSubmitError(null);
    }
    onOpenChange(newOpen);
  };

  const isSubmitEnabled = text.trim().length > 0 && !isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        data-testid="feedback-modal"
        className="max-w-sm w-full"
        onInteractOutside={(e) => {
          // Mobile keyboard fix: tapping outside to dismiss the on-screen keyboard
          // registers as an outside interaction, which Radix treats as a close —
          // discarding a half-written note. Block outside-dismiss while a draft
          // exists (the tap still blurs the textarea, so the keyboard closes). The
          // X and Cancel buttons remain the explicit ways to close.
          if (text.trim()) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            What's working, what's not, or what feature you'd like to see.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-text-input" className="text-sm font-medium">
              Your feedback
            </label>
            <textarea
              id="feedback-text-input"
              data-testid="feedback-text"
              aria-required="true"
              aria-label="Your feedback"
              placeholder="Tell us what you think about FlawChess or this page in particular"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full resize-none rounded-lg border border-input bg-input/30 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/50 focus:border-ring disabled:opacity-50"
              disabled={isPending}
            />
          </div>

          <div
            // Cumulative star rating exposed as deselectable toggle buttons. aria-pressed
            // tracks the filled state (stars 1..rating), so a screen reader announces the
            // same fill the user sees. role="group" (not radiogroup) because the control is
            // optional and clearable, which a radiogroup forbids.
            role="group"
            aria-label="Rate your experience (optional)"
            data-testid="feedback-rating"
            className="flex items-center justify-center gap-1"
          >
            {STAR_VALUES.map((value) => {
              const isFilled = rating !== undefined && value <= rating;
              return (
                <button
                  key={value}
                  type="button"
                  data-testid={`feedback-rating-${value}`}
                  aria-label={`Rate ${value} ${value === 1 ? 'star' : 'stars'}`}
                  aria-pressed={isFilled}
                  onClick={() => handleStarClick(value)}
                  disabled={isPending}
                  className="rounded p-1 transition-colors hover:brightness-125 disabled:opacity-50"
                >
                  <Star
                    className={[
                      'size-6',
                      isFilled
                        ? 'fill-brand-brown text-brand-brown'
                        : 'fill-none text-brand-brown',
                    ].join(' ')}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>

          {submitError && (
            <p className="text-sm text-destructive" role="alert">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              data-testid="btn-feedback-cancel"
              onClick={() => handleOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="btn-feedback-submit"
              disabled={!isSubmitEnabled}
            >
              {isPending ? 'Sending...' : 'Send feedback'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
