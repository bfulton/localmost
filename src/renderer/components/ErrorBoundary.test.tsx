import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary';
import { mockLocalmost } from '../../../test/setup-renderer';

// Component that throws an error
const ThrowError: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow = true }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>No error</div>;
};

// Suppress console.error for expected errors
const originalError = console.error;
beforeAll(() => {
  console.error = jest.fn();
});

afterAll(() => {
  console.error = originalError;
});

describe('ErrorBoundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Normal Operation', () => {
    it('should render children when no error', () => {
      render(
        <ErrorBoundary>
          <div>Child content</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Child content')).toBeInTheDocument();
    });

    it('should render multiple children', () => {
      render(
        <ErrorBoundary>
          <div>First child</div>
          <div>Second child</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('First child')).toBeInTheDocument();
      expect(screen.getByText('Second child')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('should catch errors and display fallback UI', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText('An unexpected error occurred in the application.')).toBeInTheDocument();
    });

    it('should display error message in technical details', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Technical details (for developers)')).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should log error to console', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(console.error).toHaveBeenCalledWith(
        'ErrorBoundary caught an error:',
        expect.any(Error),
        expect.any(Object)
      );
    });

    it('should log error to main process if available', () => {
      // Mock logs.write as available
      mockLocalmost.logs.write = jest.fn();

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(mockLocalmost.logs.write).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'error',
          message: expect.stringContaining('Test error message'),
        })
      );
    });
  });

  describe('Custom Fallback', () => {
    it('should render custom fallback when provided', () => {
      render(
        <ErrorBoundary fallback={<div>Custom error page</div>}>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom error page')).toBeInTheDocument();
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });
  });

  describe('Recovery Actions', () => {
    it('should show reload button', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: 'Reload Application' })).toBeInTheDocument();
    });

    it('should show try again button', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });

    it('should reload page when reload button clicked', () => {
      // Mock window.location.reload
      const reloadMock = jest.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
      });

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Reload Application' }));

      expect(reloadMock).toHaveBeenCalled();
    });

    it('should reset error state when try again clicked', () => {
      const TestComponent: React.FC = () => {
        const [shouldThrow, setShouldThrow] = React.useState(true);

        return (
          <div>
            <button onClick={() => setShouldThrow(false)}>Fix Error</button>
            <ErrorBoundary>
              <ThrowError shouldThrow={shouldThrow} />
            </ErrorBoundary>
          </div>
        );
      };

      render(<TestComponent />);

      // Initially shows error
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Fix the error condition first
      fireEvent.click(screen.getByText('Fix Error'));

      // Then try again
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));

      // Should render children now
      expect(screen.getByText('No error')).toBeInTheDocument();
    });
  });

  describe('Error Details', () => {
    it('should show component stack in error details', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // Click to expand details
      fireEvent.click(screen.getByText('Technical details (for developers)'));

      // Component stack should be visible in the error-stack element
      const errorStack = document.querySelector('.error-stack');
      expect(errorStack).toBeInTheDocument();
    });

    it('should be collapsible details section', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const details = screen.getByText('Technical details (for developers)').closest('details');
      expect(details).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors without logs.write available', () => {
      // Remove logs.write
      const original = mockLocalmost.logs.write;
      delete (mockLocalmost.logs as any).write;

      // Should not throw
      expect(() => {
        render(
          <ErrorBoundary>
            <ThrowError />
          </ErrorBoundary>
        );
      }).not.toThrow();

      // Restore
      mockLocalmost.logs.write = original;
    });

    it('should handle nested error boundaries', () => {
      render(
        <ErrorBoundary fallback={<div>Outer fallback</div>}>
          <div>
            <ErrorBoundary fallback={<div>Inner fallback</div>}>
              <ThrowError />
            </ErrorBoundary>
          </div>
        </ErrorBoundary>
      );

      // Inner boundary should catch the error
      expect(screen.getByText('Inner fallback')).toBeInTheDocument();
      expect(screen.queryByText('Outer fallback')).not.toBeInTheDocument();
    });
  });
});
