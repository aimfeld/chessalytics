import { Link } from 'react-router';
import { Button } from '@/components/ui/button';

export function PublicHeader() {
  return (
    <header
      data-testid="public-header"
      className="sticky top-0 z-40 border-b border-border bg-background px-6 overflow-hidden"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between py-2">
        {/* Logo + brand name */}
        <Link to="/" className="flex items-end gap-1.5 self-end">
          <img src="/icons/logo-128.png" alt="" className="h-11 w-11 -mb-2" aria-hidden="true" />
          <span className="self-center text-lg tracking-tight font-brand">FlawChess</span>
        </Link>

        {/* Navigation + auth */}
        <div className="flex items-center gap-4">
          <nav className="hidden sm:flex items-center gap-4 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors" data-testid="nav-features">Features</a>
            <a href="#faq" className="hover:text-foreground transition-colors" data-testid="nav-faq">FAQ</a>
          </nav>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" asChild data-testid="nav-login">
              <Link to="/login">Log in</Link>
            </Button>
            <Button size="sm" asChild data-testid="nav-signup">
              <Link to="/login?tab=register">Sign up free</Link>
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}
