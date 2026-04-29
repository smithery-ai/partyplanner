import { type Atom, atom } from "@workflow/core";
import {
  type ArcadeToolResult,
  type LinearJsonObject,
  type LinearToolOptions,
  listIssues,
  listProjects,
  type MaybeHandle,
} from "@workflow/integrations-linear";

export type ListProjectsAndMyTicketsOptions = LinearToolOptions & {
  projectLimit?: MaybeHandle<number | undefined>;
  issueLimit?: MaybeHandle<number | undefined>;
  team?: MaybeHandle<string | undefined>;
  projectState?: MaybeHandle<string | undefined>;
  issueState?: MaybeHandle<string | undefined>;
};

export type LinearProjectsAndMyTickets = {
  projects: ArcadeToolResult<LinearJsonObject>;
  ticketsAssignedToMe: ArcadeToolResult<LinearJsonObject>;
};

export function listProjectsAndMyTickets(
  opts: ListProjectsAndMyTicketsOptions = {},
): Atom<LinearProjectsAndMyTickets> {
  const arcadeOpts = {
    auth: opts.auth,
    userId: opts.userId,
    toolVersion: opts.toolVersion,
    nextUri: opts.nextUri,
    includeErrorStacktrace: opts.includeErrorStacktrace,
    authorize: opts.authorize,
  };

  return atom(
    (get) => ({
      projects: get(
        listProjects({
          ...arcadeOpts,
          limit: opts.projectLimit ?? 50,
          state: opts.projectState,
          team: opts.team,
        }),
      ),
      ticketsAssignedToMe: get(
        listIssues({
          ...arcadeOpts,
          assignee: "@me",
          limit: opts.issueLimit ?? 10,
          state: opts.issueState,
          team: opts.team,
        }),
      ),
    }),
    { name: opts.actionName ?? "linearProjectsAndMyTickets" },
  );
}

export const linearProjectsAndMyTickets = listProjectsAndMyTickets({
  actionName: "linearProjectsAndMyTickets",
});
