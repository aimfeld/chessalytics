import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';

import { apiClient } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { useDebounce } from '@/hooks/useDebounce';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { LoadError } from '@/components/ui/load-error';
import {
  Command, CommandInput, CommandList, CommandItem, CommandEmpty, CommandGroup,
} from '@/components/ui/command';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import type { UserSearchResult } from '@/types/admin';

// D-12: min query length. D-13: backend caps at 20 rows.
const MIN_QUERY_LEN = 2;
const DEBOUNCE_MS = 250;
const SEARCH_STALE_MS = 10_000;

function formatLastLogin(iso: string | null): string {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString();
}

export function ImpersonationSelector() {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const debounced = useDebounce(query, DEBOUNCE_MS);
  const { impersonate } = useAuth();
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery<UserSearchResult[]>({
    queryKey: ['admin', 'users-search', debounced],
    queryFn: async () => {
      const res = await apiClient.get<UserSearchResult[]>('/admin/users/search', {
        params: { q: debounced },
      });
      return res.data;
    },
    enabled: debounced.length >= MIN_QUERY_LEN,
    staleTime: SEARCH_STALE_MS,
  });

  async function handleSelect(userId: number) {
    setOpen(false);
    await impersonate(userId);
    // Route to the Library: LibraryPage redirects /library -> /library/games, or
    // /library/import when the impersonated user has no games. impersonate() clears
    // the query cache, so the profile refetches for the new user before that redirect
    // evaluates. (Previously landed on the Openings explorer, which is empty/locked
    // for users with no imported games.)
    navigate('/library');
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="brand-outline"
          data-testid="btn-impersonate-selector"
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <ShieldCheck className="h-4 w-4 mr-2" aria-hidden="true" />
          Select user to impersonate
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[28rem] max-w-[calc(100vw-2rem)]" align="start">
        {/* shouldFilter=false: backend already filters; without this cmdk hides server results */}
        <Command shouldFilter={false} data-testid="admin-combobox">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by email, username, or id"
            data-testid="admin-combobox-input"
          />
          <CommandList>
            {debounced.length < MIN_QUERY_LEN && (
              <div className="p-3 text-xs text-muted-foreground" data-testid="admin-combobox-hint">
                Type at least {MIN_QUERY_LEN} characters to search.
              </div>
            )}
            {isLoading && debounced.length >= MIN_QUERY_LEN && (
              <div className="p-3 text-xs text-muted-foreground" data-testid="admin-combobox-loading">
                Searching...
              </div>
            )}
            {isError && (
              <LoadError
                resource="users"
                className="p-3 text-destructive"
                data-testid="admin-combobox-error"
              />
            )}
            {data && data.length === 0 && !isLoading && !isError && debounced.length >= MIN_QUERY_LEN && (
              <CommandEmpty data-testid="admin-combobox-empty">No users found.</CommandEmpty>
            )}
            {data && data.length > 0 && (
              <CommandGroup heading="Users">
                {data.map((u) => (
                  <CommandItem
                    key={u.id}
                    value={`${u.id}-${u.email}`}
                    onSelect={() => { void handleSelect(u.id); }}
                    data-testid={`admin-combobox-item-${u.id}`}
                    className="flex items-start gap-2 cursor-pointer"
                  >
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="truncate text-sm">{u.email}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        id {u.id}
                        {u.chess_com_username ? ` · chess.com: ${u.chess_com_username}` : ''}
                        {u.lichess_username ? ` · lichess: ${u.lichess_username}` : ''}
                        {` · last login: ${formatLastLogin(u.last_login)}`}
                      </span>
                    </div>
                    {u.is_guest && (
                      <Badge
                        className="bg-amber-500/15 text-amber-500 border-amber-500/30 text-xs"
                        data-testid={`admin-combobox-item-${u.id}-guest-badge`}
                      >
                        Guest
                      </Badge>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
