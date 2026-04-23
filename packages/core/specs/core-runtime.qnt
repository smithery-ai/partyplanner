// Finite model of the @workflow/core runtime contract described in README.md.
//
// The graph is intentionally larger than a toy chain:
//
//   Slack/Email/GitHub/Webhook -> ExtractText -> Classify -> NeedsApproval -> HumanPrompt
//                  GitHub -> Review -> Enrich -> Metrics
//   Approval(deferred) ------------------^
//   HumanPromptResponse(out-of-band) ------------------------------^
//   ApiKey(secret) ---------------------------------------------> Notify(action) -> Audit, Receipt
//
// This model checks safety properties for dynamic input fanout, skipped branch
// recovery, deferred waits, out-of-band human prompt re-entry, webhook
// idempotency, dependency wakeups, pull-only actions, side-effect
// deduplication, atom error propagation, and secret redaction.
module core_runtime {
  type NodeId =
    | Slack
    | Email
    | Github
    | Webhook
    | Approval
    | HumanPromptResponse
    | ApiKey
    | ExtractText
    | Classify
    | Review
    | Enrich
    | NeedsApproval
    | HumanPrompt
    | Notify
    | Audit
    | Receipt
    | Metrics

  type Status =
    | NotReached
    | Resolved
    | Skipped
    | Waiting
    | Blocked
    | Errored

  type EventId =
    | SlackFirst
    | SlackUpdate
    | EmailFirst
    | GithubFirst
    | WebhookFirst
    | WebhookRetry
    | ApprovalEvent
    | PromptApprovalEvent
    | PromptDenialEvent
    | PromptStaleApprovalEvent
    | SecretEvent

  type Payload =
    | NoPayload
    | SlackNormalPayload
    | SlackUrgentPayload
    | EmailNormalPayload
    | EmailUrgentPayload
    | GithubSmallPayload
    | GithubLargePayload
    | WebhookNormalPayload
    | WebhookUrgentPayload
    | ApprovalGrantedPayload
    | ApprovalDeniedPayload
    | PromptApprovedPayload
    | PromptDeniedPayload
    | SecretPayloadRedacted

  type SourcePayload =
    | SlackNormal
    | SlackUrgent
    | EmailNormal
    | EmailUrgent
    | GithubSmall
    | GithubLarge
    | WebhookNormal
    | WebhookUrgent

  type ApprovalValue =
    | ApprovalUnknown
    | Approved
    | Denied

  type Risk =
    | UnknownRisk
    | NormalRisk
    | HighRisk

  type SecretStore =
    | NoSecret
    | RedactedSecret
    | PlainSecret

  pure val NODES: Set[NodeId] =
    Set(Slack, Email, Github, Webhook, Approval, HumanPromptResponse, ApiKey, ExtractText, Classify, Review, Enrich, NeedsApproval, HumanPrompt, Notify, Audit, Receipt, Metrics)

  pure val INPUTS: Set[NodeId] =
    Set(Slack, Email, Github, Webhook, Approval, ApiKey)

  pure val SOURCE_INPUTS: Set[NodeId] =
    Set(Slack, Email, Github, Webhook)

  pure val DEFERRED_INPUTS: Set[NodeId] =
    Set(Approval)

  pure val SECRETS: Set[NodeId] =
    Set(ApiKey)

  pure val ATOMS: Set[NodeId] =
    Set(ExtractText, Classify, Review, Enrich, NeedsApproval, HumanPrompt, Audit, Receipt, Metrics)

  pure val ACTIONS: Set[NodeId] =
    Set(Notify)

  pure val STEPS: Set[NodeId] =
    ATOMS.union(ACTIONS)

  pure val SOURCE_TRACKED_ATOMS: Set[NodeId] =
    Set(ExtractText, Classify, Review, Enrich, NeedsApproval, HumanPrompt, Metrics)

  pure val SOURCE_DIRTY_STEPS: Set[NodeId] =
    ATOMS.union(Set(Notify))

  pure val EVENTS: Set[EventId] =
    Set(SlackFirst, SlackUpdate, EmailFirst, GithubFirst, WebhookFirst, WebhookRetry, ApprovalEvent, PromptApprovalEvent, PromptDenialEvent, PromptStaleApprovalEvent, SecretEvent)

  pure val SOURCE_PAYLOADS: Set[SourcePayload] =
    Set(SlackNormal, SlackUrgent, EmailNormal, EmailUrgent, GithubSmall, GithubLarge, WebhookNormal, WebhookUrgent)

  pure val EMPTY_NODES: Set[NodeId] =
    NODES.filter(_ => false)

  pure val EMPTY_EVENTS: Set[EventId] =
    EVENTS.filter(_ => false)

  pure val STATUS_VALUES: Set[Status] =
    Set(NotReached, Resolved, Skipped, Waiting, Blocked, Errored)

  pure val PAYLOAD_VALUES: Set[Payload] =
    Set(NoPayload, SlackNormalPayload, SlackUrgentPayload, EmailNormalPayload, EmailUrgentPayload, GithubSmallPayload, GithubLargePayload, WebhookNormalPayload, WebhookUrgentPayload, ApprovalGrantedPayload, ApprovalDeniedPayload, PromptApprovedPayload, PromptDeniedPayload, SecretPayloadRedacted)

  pure val APPROVAL_VALUES: Set[ApprovalValue] =
    Set(ApprovalUnknown, Approved, Denied)

  pure val RISK_VALUES: Set[Risk] =
    Set(UnknownRisk, NormalRisk, HighRisk)

  pure val SECRET_VALUES: Set[SecretStore] =
    Set(NoSecret, RedactedSecret, PlainSecret)

  pure val SMALL_NATS: Set[int] =
    0.to(40)

  var status: NodeId -> Status
  var deps: NodeId -> Set[NodeId]
  var waiters: NodeId -> Set[NodeId]
  var queue: Set[NodeId]
  var processed: Set[EventId]
  var trigger: Payload
  var sourceRisk: Risk
  var approval: ApprovalValue
  var storedSecret: SecretStore
  var sourceVersion: int
  var version: NodeId -> int
  var notifyEffects: int
  var inputFanoutQueuedAction: bool

  pure def isTerminal(s): (Status) => bool =
    s.in(Set(Resolved, Skipped, Errored))

  pure def terminalSteps(st): (NodeId -> Status) => Set[NodeId] =
    STEPS.filter(n => isTerminal(st.get(n)))

  pure def addToQueue(q, st, candidates): (Set[NodeId], NodeId -> Status, Set[NodeId]) => Set[NodeId] =
    q.union(candidates).exclude(terminalSteps(st))

  pure def dirtySourceSteps(st): (NodeId -> Status) => NodeId -> Status =
    st
      .set(ExtractText, NotReached)
      .set(Classify, NotReached)
      .set(Review, NotReached)
      .set(Enrich, NotReached)
      .set(NeedsApproval, NotReached)
      .set(HumanPrompt, NotReached)
      .set(HumanPromptResponse, NotReached)
      .set(Audit, NotReached)
      .set(Receipt, NotReached)
      .set(Metrics, NotReached)
      .set(Notify, if (st.get(Notify) == Resolved) Resolved else NotReached)

  pure def clearDirtyWaiters(ws): (NodeId -> Set[NodeId]) => NodeId -> Set[NodeId] =
    NODES.mapBy(dep => ws.get(dep).exclude(SOURCE_DIRTY_STEPS))

  pure def finishWaiters(ws, stepId): (NodeId -> Set[NodeId], NodeId) => NodeId -> Set[NodeId] =
    NODES.mapBy(dep =>
      if (dep == stepId) EMPTY_NODES else ws.get(dep).exclude(Set(stepId))
    )

  pure def riskFor(p): (SourcePayload) => Risk =
    if (p.in(Set(SlackUrgent, EmailUrgent, GithubLarge))) HighRisk else NormalRisk

  pure def payloadFor(p): (SourcePayload) => Payload =
    match p {
      | SlackNormal => SlackNormalPayload
      | SlackUrgent => SlackUrgentPayload
      | EmailNormal => EmailNormalPayload
      | EmailUrgent => EmailUrgentPayload
      | GithubSmall => GithubSmallPayload
      | GithubLarge => GithubLargePayload
      | WebhookNormal => WebhookNormalPayload
      | WebhookUrgent => WebhookUrgentPayload
    }

  pure def inputFor(p): (SourcePayload) => NodeId =
    match p {
      | SlackNormal => Slack
      | SlackUrgent => Slack
      | EmailNormal => Email
      | EmailUrgent => Email
      | GithubSmall => Github
      | GithubLarge => Github
      | WebhookNormal => Webhook
      | WebhookUrgent => Webhook
    }

  pure def eventMatchesPayload(ev, p): (EventId, SourcePayload) => bool =
    any {
      ev.in(Set(SlackFirst, SlackUpdate)) and p.in(Set(SlackNormal, SlackUrgent)),
      ev == EmailFirst and p.in(Set(EmailNormal, EmailUrgent)),
      ev == GithubFirst and p.in(Set(GithubSmall, GithubLarge)),
      ev.in(Set(WebhookFirst, WebhookRetry)) and p.in(Set(WebhookNormal, WebhookUrgent)),
    }

  def fanoutFor(input): (NodeId) => Set[NodeId] =
    if (waiters.get(input).size() > 0) waiters.get(input) else ATOMS

  action init = all {
    status' = NODES.mapBy(_ => NotReached),
    deps' = NODES.mapBy(_ => EMPTY_NODES),
    waiters' = NODES.mapBy(_ => EMPTY_NODES),
    queue' = EMPTY_NODES,
    processed' = EMPTY_EVENTS,
    trigger' = NoPayload,
    sourceRisk' = UnknownRisk,
    approval' = ApprovalUnknown,
    storedSecret' = NoSecret,
    sourceVersion' = 0,
    version' = NODES.mapBy(_ => 0),
    notifyEffects' = 0,
    inputFanoutQueuedAction' = false,
  }

  action submitSource(ev, p): (EventId, SourcePayload) => bool = all {
    eventMatchesPayload(ev, p),
    not(processed.contains(ev)),
    status' = dirtySourceSteps(status.set(inputFor(p), Resolved)),
    deps' = deps.set(inputFor(p), EMPTY_NODES),
    waiters' = clearDirtyWaiters(waiters).set(inputFor(p), EMPTY_NODES),
    queue' = addToQueue(queue.exclude(Set(Notify)), dirtySourceSteps(status.set(inputFor(p), Resolved)), ATOMS.union(fanoutFor(inputFor(p)))),
    processed' = processed.union(Set(ev)),
    trigger' = if (trigger == NoPayload) payloadFor(p) else trigger,
    sourceRisk' = riskFor(p),
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion + 1,
    version' = version.set(inputFor(p), sourceVersion + 1),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' =
      (inputFanoutQueuedAction
        or (waiters.get(inputFor(p)).size() == 0 and fanoutFor(inputFor(p)).intersect(ACTIONS).size() > 0)),
  }

  action submitApprovalGranted = all {
    not(processed.contains(ApprovalEvent)),
    status' = status.set(Approval, Resolved),
    deps' = deps.set(Approval, EMPTY_NODES),
    waiters' = waiters.set(Approval, EMPTY_NODES),
    queue' = addToQueue(queue, status.set(Approval, Resolved), fanoutFor(Approval)),
    processed' = processed.union(Set(ApprovalEvent)),
    trigger' = if (trigger == NoPayload) ApprovalGrantedPayload else trigger,
    sourceRisk' = sourceRisk,
    approval' = Approved,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Approval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' =
      (inputFanoutQueuedAction
        or (waiters.get(Approval).size() == 0 and fanoutFor(Approval).intersect(ACTIONS).size() > 0)),
  }

  action submitApprovalDenied = all {
    not(processed.contains(ApprovalEvent)),
    status' = status.set(Approval, Resolved),
    deps' = deps.set(Approval, EMPTY_NODES),
    waiters' = waiters.set(Approval, EMPTY_NODES),
    queue' = addToQueue(queue, status.set(Approval, Resolved), fanoutFor(Approval)),
    processed' = processed.union(Set(ApprovalEvent)),
    trigger' = if (trigger == NoPayload) ApprovalDeniedPayload else trigger,
    sourceRisk' = sourceRisk,
    approval' = Denied,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Approval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' =
      (inputFanoutQueuedAction
        or (waiters.get(Approval).size() == 0 and fanoutFor(Approval).intersect(ACTIONS).size() > 0)),
  }

  action submitPromptApproved = all {
    not(processed.contains(PromptApprovalEvent)),
    status.get(HumanPrompt) == Waiting,
    version.get(HumanPromptResponse) == sourceVersion,
    status' = status.set(HumanPromptResponse, Resolved),
    deps' = deps.set(HumanPromptResponse, EMPTY_NODES),
    waiters' = waiters.set(HumanPromptResponse, EMPTY_NODES),
    queue' = addToQueue(queue, status.set(HumanPromptResponse, Resolved), waiters.get(HumanPromptResponse)),
    processed' = processed.union(Set(PromptApprovalEvent)),
    trigger' = if (trigger == NoPayload) PromptApprovedPayload else trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPromptResponse, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action submitPromptDenied = all {
    not(processed.contains(PromptDenialEvent)),
    status.get(HumanPrompt) == Waiting,
    version.get(HumanPromptResponse) == sourceVersion,
    status' = status.set(HumanPromptResponse, Skipped),
    deps' = deps.set(HumanPromptResponse, EMPTY_NODES),
    waiters' = waiters.set(HumanPromptResponse, EMPTY_NODES),
    queue' = addToQueue(queue, status.set(HumanPromptResponse, Skipped), waiters.get(HumanPromptResponse)),
    processed' = processed.union(Set(PromptDenialEvent)),
    trigger' = if (trigger == NoPayload) PromptDeniedPayload else trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPromptResponse, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action submitStalePromptApproved = all {
    not(processed.contains(PromptStaleApprovalEvent)),
    status.get(HumanPromptResponse) != Resolved,
    version.get(HumanPromptResponse) != sourceVersion,
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed.union(Set(PromptStaleApprovalEvent)),
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action submitSecret = all {
    not(processed.contains(SecretEvent)),
    status' = status.set(ApiKey, Resolved),
    deps' = deps.set(ApiKey, EMPTY_NODES),
    waiters' = waiters.set(ApiKey, EMPTY_NODES),
    queue' = addToQueue(queue, status.set(ApiKey, Resolved), fanoutFor(ApiKey)),
    processed' = processed.union(Set(SecretEvent)),
    trigger' = if (trigger == NoPayload) SecretPayloadRedacted else trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = RedactedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(ApiKey, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' =
      (inputFanoutQueuedAction
        or (waiters.get(ApiKey).size() == 0 and fanoutFor(ApiKey).intersect(ACTIONS).size() > 0)),
  }

  action replaySlackFirst = all {
    processed.contains(SlackFirst),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replaySlackUpdate = all {
    processed.contains(SlackUpdate),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayEmailFirst = all {
    processed.contains(EmailFirst),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayGithubFirst = all {
    processed.contains(GithubFirst),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayWebhookFirst = all {
    processed.contains(WebhookFirst),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayWebhookRetry = all {
    processed.contains(WebhookRetry),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayApproval = all {
    processed.contains(ApprovalEvent),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayPromptApproved = all {
    processed.contains(PromptApprovalEvent),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayPromptDenied = all {
    processed.contains(PromptDenialEvent),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replayStalePromptApproved = all {
    processed.contains(PromptStaleApprovalEvent),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action replaySecret = all {
    processed.contains(SecretEvent),
    status' = status,
    deps' = deps,
    waiters' = waiters,
    queue' = queue,
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processExtractTextResolved = all {
    queue.contains(ExtractText),
    SOURCE_INPUTS.exists(input => status.get(input) == Resolved),
    status' = status.set(ExtractText, Resolved),
    deps' = deps.set(ExtractText, SOURCE_INPUTS),
    waiters' = finishWaiters(waiters, ExtractText),
    queue' = addToQueue(queue.exclude(Set(ExtractText)), status.set(ExtractText, Resolved), waiters.get(ExtractText)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(ExtractText, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processExtractTextSkipped = all {
    queue.contains(ExtractText),
    SOURCE_INPUTS.forall(input => status.get(input) != Resolved),
    status' = status.set(ExtractText, Skipped),
    deps' = deps.set(ExtractText, SOURCE_INPUTS),
    waiters' = finishWaiters(waiters, ExtractText),
    queue' = addToQueue(queue.exclude(Set(ExtractText)), status.set(ExtractText, Skipped), waiters.get(ExtractText)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(ExtractText, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processClassifyResolved = all {
    queue.contains(Classify),
    status.get(ExtractText) == Resolved,
    status' = status.set(Classify, Resolved),
    deps' = deps.set(Classify, Set(ExtractText)),
    waiters' = finishWaiters(waiters, Classify),
    queue' = addToQueue(queue.exclude(Set(Classify)), status.set(Classify, Resolved), waiters.get(Classify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Classify, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processClassifySkipped = all {
    queue.contains(Classify),
    status.get(ExtractText) == Skipped,
    status' = status.set(Classify, Skipped),
    deps' = deps.set(Classify, Set(ExtractText)),
    waiters' = finishWaiters(waiters, Classify),
    queue' = addToQueue(queue.exclude(Set(Classify)), status.set(Classify, Skipped), waiters.get(Classify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Classify, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processClassifyBlocked = all {
    queue.contains(Classify),
    not(isTerminal(status.get(ExtractText))),
    status' = status.set(Classify, Blocked),
    deps' = deps.set(Classify, Set(ExtractText)),
    waiters' = waiters.set(ExtractText, waiters.get(ExtractText).union(Set(Classify))),
    queue' = addToQueue(queue.exclude(Set(Classify)), status.set(Classify, Blocked), Set(ExtractText)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processClassifyUnexpectedError = all {
    queue.contains(Classify),
    status.get(ExtractText) == Resolved,
    status' = status.set(Classify, Errored),
    deps' = deps.set(Classify, Set(ExtractText)),
    waiters' = finishWaiters(waiters, Classify),
    queue' = addToQueue(queue.exclude(Set(Classify)), status.set(Classify, Errored), waiters.get(Classify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Classify, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processReviewResolved = all {
    queue.contains(Review),
    status.get(Github) == Resolved,
    status' = status.set(Review, Resolved),
    deps' = deps.set(Review, Set(Github)),
    waiters' = finishWaiters(waiters, Review),
    queue' = addToQueue(queue.exclude(Set(Review)), status.set(Review, Resolved), waiters.get(Review)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Review, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processReviewSkipped = all {
    queue.contains(Review),
    status.get(Github) != Resolved,
    status' = status.set(Review, Skipped),
    deps' = deps.set(Review, Set(Github)),
    waiters' = finishWaiters(waiters, Review),
    queue' = addToQueue(queue.exclude(Set(Review)), status.set(Review, Skipped), waiters.get(Review)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Review, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processEnrichResolved = all {
    queue.contains(Enrich),
    status.get(ExtractText) == Resolved,
    any { status.get(Github) != Resolved, status.get(Review).in(Set(Resolved, Skipped)) },
    status' = status.set(Enrich, Resolved),
    deps' = deps.set(Enrich, Set(ExtractText, Review)),
    waiters' = finishWaiters(waiters, Enrich),
    queue' = addToQueue(queue.exclude(Set(Enrich)), status.set(Enrich, Resolved), waiters.get(Enrich)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Enrich, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processEnrichSkipped = all {
    queue.contains(Enrich),
    status.get(ExtractText) == Skipped,
    status' = status.set(Enrich, Skipped),
    deps' = deps.set(Enrich, Set(ExtractText)),
    waiters' = finishWaiters(waiters, Enrich),
    queue' = addToQueue(queue.exclude(Set(Enrich)), status.set(Enrich, Skipped), waiters.get(Enrich)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Enrich, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processEnrichBlockedOnExtract = all {
    queue.contains(Enrich),
    not(isTerminal(status.get(ExtractText))),
    status' = status.set(Enrich, Blocked),
    deps' = deps.set(Enrich, Set(ExtractText)),
    waiters' = waiters.set(ExtractText, waiters.get(ExtractText).union(Set(Enrich))),
    queue' = addToQueue(queue.exclude(Set(Enrich)), status.set(Enrich, Blocked), Set(ExtractText)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processEnrichBlockedOnReview = all {
    queue.contains(Enrich),
    status.get(ExtractText) == Resolved,
    status.get(Github) == Resolved,
    not(isTerminal(status.get(Review))),
    status' = status.set(Enrich, Blocked),
    deps' = deps.set(Enrich, Set(ExtractText, Review)),
    waiters' = waiters.set(Review, waiters.get(Review).union(Set(Enrich))),
    queue' = addToQueue(queue.exclude(Set(Enrich)), status.set(Enrich, Blocked), Set(Review)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processEnrichUnexpectedError = all {
    queue.contains(Enrich),
    status.get(ExtractText) == Resolved,
    status' = status.set(Enrich, Errored),
    deps' = deps.set(Enrich, Set(ExtractText, Review)),
    waiters' = finishWaiters(waiters, Enrich),
    queue' = addToQueue(queue.exclude(Set(Enrich)), status.set(Enrich, Errored), waiters.get(Enrich)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Enrich, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalNormal = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Resolved,
    sourceRisk == NormalRisk,
    status' = status.set(NeedsApproval, Resolved),
    deps' = deps.set(NeedsApproval, Set(Classify)),
    waiters' = finishWaiters(waiters, NeedsApproval),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Resolved), waiters.get(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(NeedsApproval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalApproved = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Resolved,
    sourceRisk == HighRisk,
    approval == Approved,
    status' = status.set(NeedsApproval, Resolved),
    deps' = deps.set(NeedsApproval, Set(Classify, Approval)),
    waiters' = finishWaiters(waiters, NeedsApproval),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Resolved), waiters.get(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(NeedsApproval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalDenied = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Resolved,
    sourceRisk == HighRisk,
    approval == Denied,
    status' = status.set(NeedsApproval, Skipped),
    deps' = deps.set(NeedsApproval, Set(Classify, Approval)),
    waiters' = finishWaiters(waiters, NeedsApproval),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Skipped), waiters.get(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(NeedsApproval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalWaiting = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Resolved,
    sourceRisk == HighRisk,
    approval == ApprovalUnknown,
    status' = status.set(NeedsApproval, Waiting),
    deps' = deps.set(NeedsApproval, Set(Classify, Approval)),
    waiters' = waiters.set(Approval, waiters.get(Approval).union(Set(NeedsApproval))),
    queue' = queue.exclude(Set(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalSkipped = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Skipped,
    status' = status.set(NeedsApproval, Skipped),
    deps' = deps.set(NeedsApproval, Set(Classify)),
    waiters' = finishWaiters(waiters, NeedsApproval),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Skipped), waiters.get(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(NeedsApproval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalBlocked = all {
    queue.contains(NeedsApproval),
    not(isTerminal(status.get(Classify))),
    status' = status.set(NeedsApproval, Blocked),
    deps' = deps.set(NeedsApproval, Set(Classify)),
    waiters' = waiters.set(Classify, waiters.get(Classify).union(Set(NeedsApproval))),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Blocked), Set(Classify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNeedsApprovalErroredFromClassify = all {
    queue.contains(NeedsApproval),
    status.get(Classify) == Errored,
    status' = status.set(NeedsApproval, Errored),
    deps' = deps.set(NeedsApproval, Set(Classify)),
    waiters' = finishWaiters(waiters, NeedsApproval),
    queue' = addToQueue(queue.exclude(Set(NeedsApproval)), status.set(NeedsApproval, Errored), waiters.get(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(NeedsApproval, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptNoPrompt = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Resolved,
    sourceRisk == NormalRisk,
    status' = status.set(HumanPrompt, Resolved),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval)),
    waiters' = finishWaiters(waiters, HumanPrompt),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Resolved), waiters.get(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPrompt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptRequest = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Resolved,
    sourceRisk == HighRisk,
    status.get(HumanPromptResponse) == NotReached,
    status' = status.set(HumanPrompt, Waiting),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval, HumanPromptResponse)),
    waiters' = waiters.set(HumanPromptResponse, waiters.get(HumanPromptResponse).union(Set(HumanPrompt))),
    queue' = queue.exclude(Set(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPromptResponse, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptApproved = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Resolved,
    sourceRisk == HighRisk,
    status.get(HumanPromptResponse) == Resolved,
    version.get(HumanPromptResponse) == sourceVersion,
    status' = status.set(HumanPrompt, Resolved),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval, HumanPromptResponse)),
    waiters' = finishWaiters(waiters, HumanPrompt),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Resolved), waiters.get(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPrompt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptDenied = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Resolved,
    sourceRisk == HighRisk,
    status.get(HumanPromptResponse) == Skipped,
    version.get(HumanPromptResponse) == sourceVersion,
    status' = status.set(HumanPrompt, Skipped),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval, HumanPromptResponse)),
    waiters' = finishWaiters(waiters, HumanPrompt),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Skipped), waiters.get(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPrompt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptSkipped = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Skipped,
    status' = status.set(HumanPrompt, Skipped),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval)),
    waiters' = finishWaiters(waiters, HumanPrompt),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Skipped), waiters.get(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPrompt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptBlocked = all {
    queue.contains(HumanPrompt),
    not(isTerminal(status.get(NeedsApproval))),
    status' = status.set(HumanPrompt, Blocked),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval)),
    waiters' = waiters.set(NeedsApproval, waiters.get(NeedsApproval).union(Set(HumanPrompt))),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Blocked), Set(NeedsApproval)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processHumanPromptErroredFromNeedsApproval = all {
    queue.contains(HumanPrompt),
    status.get(NeedsApproval) == Errored,
    status' = status.set(HumanPrompt, Errored),
    deps' = deps.set(HumanPrompt, Set(NeedsApproval)),
    waiters' = finishWaiters(waiters, HumanPrompt),
    queue' = addToQueue(queue.exclude(Set(HumanPrompt)), status.set(HumanPrompt, Errored), waiters.get(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(HumanPrompt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNotifyResolved = all {
    queue.contains(Notify),
    status.get(HumanPrompt) == Resolved,
    storedSecret == RedactedSecret,
    status' = status.set(Notify, Resolved),
    deps' = deps.set(Notify, Set(HumanPrompt, ApiKey)),
    waiters' = finishWaiters(waiters, Notify),
    queue' = addToQueue(queue.exclude(Set(Notify)), status.set(Notify, Resolved), waiters.get(Notify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Notify, sourceVersion),
    notifyEffects' = notifyEffects + 1,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNotifyWaitingForSecret = all {
    queue.contains(Notify),
    status.get(HumanPrompt) == Resolved,
    storedSecret == NoSecret,
    status' = status.set(Notify, Waiting),
    deps' = deps.set(Notify, Set(HumanPrompt, ApiKey)),
    waiters' = waiters.set(ApiKey, waiters.get(ApiKey).union(Set(Notify))),
    queue' = queue.exclude(Set(Notify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNotifySkipped = all {
    queue.contains(Notify),
    status.get(HumanPrompt) == Skipped,
    status' = status.set(Notify, Skipped),
    deps' = deps.set(Notify, Set(HumanPrompt)),
    waiters' = finishWaiters(waiters, Notify),
    queue' = addToQueue(queue.exclude(Set(Notify)), status.set(Notify, Skipped), waiters.get(Notify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Notify, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNotifyBlocked = all {
    queue.contains(Notify),
    not(isTerminal(status.get(HumanPrompt))),
    status' = status.set(Notify, Blocked),
    deps' = deps.set(Notify, Set(HumanPrompt)),
    waiters' = waiters.set(HumanPrompt, waiters.get(HumanPrompt).union(Set(Notify))),
    queue' = addToQueue(queue.exclude(Set(Notify)), status.set(Notify, Blocked), Set(HumanPrompt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processNotifyErroredFromNeedsApproval = all {
    queue.contains(Notify),
    status.get(HumanPrompt) == Errored,
    status' = status.set(Notify, Errored),
    deps' = deps.set(Notify, Set(HumanPrompt)),
    waiters' = finishWaiters(waiters, Notify),
    queue' = addToQueue(queue.exclude(Set(Notify)), status.set(Notify, Errored), waiters.get(Notify)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Notify, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processAuditResolved = all {
    queue.contains(Audit),
    status.get(Notify) == Resolved,
    status' = status.set(Audit, Resolved),
    deps' = deps.set(Audit, Set(Notify)),
    waiters' = finishWaiters(waiters, Audit),
    queue' = addToQueue(queue.exclude(Set(Audit)), status.set(Audit, Resolved), waiters.get(Audit)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Audit, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processReceiptResolved = all {
    queue.contains(Receipt),
    status.get(Notify) == Resolved,
    status' = status.set(Receipt, Resolved),
    deps' = deps.set(Receipt, Set(Notify)),
    waiters' = finishWaiters(waiters, Receipt),
    queue' = addToQueue(queue.exclude(Set(Receipt)), status.set(Receipt, Resolved), waiters.get(Receipt)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Receipt, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processAuditOrReceiptSkipped = all {
    nondet consumer = oneOf(Set(Audit, Receipt))
    all {
      queue.contains(consumer),
      status.get(Notify) == Skipped,
      status' = status.set(consumer, Skipped),
      deps' = deps.set(consumer, Set(Notify)),
      waiters' = waiters.set(consumer, EMPTY_NODES),
      queue' = addToQueue(queue.exclude(Set(consumer)), status.set(consumer, Skipped), waiters.get(consumer)),
      processed' = processed,
      trigger' = trigger,
      sourceRisk' = sourceRisk,
      approval' = approval,
      storedSecret' = storedSecret,
      sourceVersion' = sourceVersion,
      version' = version.set(consumer, sourceVersion),
      notifyEffects' = notifyEffects,
      inputFanoutQueuedAction' = inputFanoutQueuedAction,
    }
  }

  action processAuditOrReceiptBlocked = all {
    nondet consumer = oneOf(Set(Audit, Receipt))
    all {
      queue.contains(consumer),
      not(isTerminal(status.get(Notify))),
      status' = status.set(consumer, Blocked),
      deps' = deps.set(consumer, Set(Notify)),
      waiters' = waiters.set(Notify, waiters.get(Notify).union(Set(consumer))),
      queue' = addToQueue(queue.exclude(Set(consumer)), status.set(consumer, Blocked), Set(Notify)),
      processed' = processed,
      trigger' = trigger,
      sourceRisk' = sourceRisk,
      approval' = approval,
      storedSecret' = storedSecret,
      sourceVersion' = sourceVersion,
      version' = version,
      notifyEffects' = notifyEffects,
      inputFanoutQueuedAction' = inputFanoutQueuedAction,
    }
  }

  action processAuditOrReceiptErrored = all {
    nondet consumer = oneOf(Set(Audit, Receipt))
    all {
      queue.contains(consumer),
      status.get(Notify) == Errored,
      status' = status.set(consumer, Errored),
      deps' = deps.set(consumer, Set(Notify)),
      waiters' = waiters.set(consumer, EMPTY_NODES),
      queue' = addToQueue(queue.exclude(Set(consumer)), status.set(consumer, Errored), waiters.get(consumer)),
      processed' = processed,
      trigger' = trigger,
      sourceRisk' = sourceRisk,
      approval' = approval,
      storedSecret' = storedSecret,
      sourceVersion' = sourceVersion,
      version' = version.set(consumer, sourceVersion),
      notifyEffects' = notifyEffects,
      inputFanoutQueuedAction' = inputFanoutQueuedAction,
    }
  }

  action processMetricsResolved = all {
    queue.contains(Metrics),
    status.get(Enrich) == Resolved,
    status' = status.set(Metrics, Resolved),
    deps' = deps.set(Metrics, Set(Enrich)),
    waiters' = finishWaiters(waiters, Metrics),
    queue' = addToQueue(queue.exclude(Set(Metrics)), status.set(Metrics, Resolved), waiters.get(Metrics)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Metrics, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processMetricsSkipped = all {
    queue.contains(Metrics),
    status.get(Enrich) == Skipped,
    status' = status.set(Metrics, Skipped),
    deps' = deps.set(Metrics, Set(Enrich)),
    waiters' = finishWaiters(waiters, Metrics),
    queue' = addToQueue(queue.exclude(Set(Metrics)), status.set(Metrics, Skipped), waiters.get(Metrics)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Metrics, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processMetricsBlocked = all {
    queue.contains(Metrics),
    not(isTerminal(status.get(Enrich))),
    status' = status.set(Metrics, Blocked),
    deps' = deps.set(Metrics, Set(Enrich)),
    waiters' = waiters.set(Enrich, waiters.get(Enrich).union(Set(Metrics))),
    queue' = addToQueue(queue.exclude(Set(Metrics)), status.set(Metrics, Blocked), Set(Enrich)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version,
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action processMetricsErroredFromEnrich = all {
    queue.contains(Metrics),
    status.get(Enrich) == Errored,
    status' = status.set(Metrics, Errored),
    deps' = deps.set(Metrics, Set(Enrich)),
    waiters' = finishWaiters(waiters, Metrics),
    queue' = addToQueue(queue.exclude(Set(Metrics)), status.set(Metrics, Errored), waiters.get(Metrics)),
    processed' = processed,
    trigger' = trigger,
    sourceRisk' = sourceRisk,
    approval' = approval,
    storedSecret' = storedSecret,
    sourceVersion' = sourceVersion,
    version' = version.set(Metrics, sourceVersion),
    notifyEffects' = notifyEffects,
    inputFanoutQueuedAction' = inputFanoutQueuedAction,
  }

  action submitAnySource = all {
    nondet p = oneOf(SOURCE_PAYLOADS)
    nondet ev = oneOf(Set(SlackFirst, SlackUpdate, EmailFirst, GithubFirst, WebhookFirst, WebhookRetry))
    submitSource(ev, p)
  }

  action step = any {
    submitAnySource,
    submitApprovalGranted,
    submitApprovalDenied,
    submitPromptApproved,
    submitPromptDenied,
    submitStalePromptApproved,
    submitSecret,
    replaySlackFirst,
    replaySlackUpdate,
    replayEmailFirst,
    replayGithubFirst,
    replayWebhookFirst,
    replayWebhookRetry,
    replayApproval,
    replayPromptApproved,
    replayPromptDenied,
    replayStalePromptApproved,
    replaySecret,
    processExtractTextResolved,
    processExtractTextSkipped,
    processClassifyResolved,
    processClassifySkipped,
    processClassifyBlocked,
    processClassifyUnexpectedError,
    processReviewResolved,
    processReviewSkipped,
    processEnrichResolved,
    processEnrichSkipped,
    processEnrichBlockedOnExtract,
    processEnrichBlockedOnReview,
    processEnrichUnexpectedError,
    processNeedsApprovalNormal,
    processNeedsApprovalApproved,
    processNeedsApprovalDenied,
    processNeedsApprovalWaiting,
    processNeedsApprovalSkipped,
    processNeedsApprovalBlocked,
    processNeedsApprovalErroredFromClassify,
    processHumanPromptNoPrompt,
    processHumanPromptRequest,
    processHumanPromptApproved,
    processHumanPromptDenied,
    processHumanPromptSkipped,
    processHumanPromptBlocked,
    processHumanPromptErroredFromNeedsApproval,
    processNotifyResolved,
    processNotifyWaitingForSecret,
    processNotifySkipped,
    processNotifyBlocked,
    processNotifyErroredFromNeedsApproval,
    processAuditResolved,
    processReceiptResolved,
    processAuditOrReceiptSkipped,
    processAuditOrReceiptBlocked,
    processAuditOrReceiptErrored,
    processMetricsResolved,
    processMetricsSkipped,
    processMetricsBlocked,
    processMetricsErroredFromEnrich,
  }

  val typeOK =
    all {
      status.in(NODES.setOfMaps(STATUS_VALUES)),
      deps.in(NODES.setOfMaps(NODES.powerset())),
      waiters.in(NODES.setOfMaps(NODES.powerset())),
      queue.subseteq(STEPS),
      processed.subseteq(EVENTS),
      trigger.in(PAYLOAD_VALUES),
      sourceRisk.in(RISK_VALUES),
      approval.in(APPROVAL_VALUES),
      storedSecret.in(SECRET_VALUES),
      sourceVersion.in(SMALL_NATS),
      version.in(NODES.setOfMaps(SMALL_NATS)),
      notifyEffects.in(0.to(1)),
    }

  val terminalStepsAreNotQueued =
    queue.intersect(terminalSteps(status)).size() == 0

  val waitersAreRunnable =
    NODES.forall(dep =>
      waiters.get(dep).subseteq(STEPS)
        and waiters.get(dep).forall(stepId => not(isTerminal(status.get(stepId))))
    )

  val blockedStepsAreWakeable =
    STEPS.forall(stepId =>
      status.get(stepId) != Blocked
        or queue.contains(stepId)
        or NODES.exists(dep => waiters.get(dep).contains(stepId))
    )

  val waitingStepsAreWakeable =
    all {
      status.get(NeedsApproval) != Waiting or waiters.get(Approval).contains(NeedsApproval) or queue.contains(NeedsApproval),
      status.get(HumanPrompt) != Waiting or waiters.get(HumanPromptResponse).contains(HumanPrompt) or queue.contains(HumanPrompt),
      status.get(Notify) != Waiting or waiters.get(ApiKey).contains(Notify) or queue.contains(Notify),
    }

  val deferredInputsDoNotSkip =
    DEFERRED_INPUTS.forall(inputId => status.get(inputId) != Skipped)

  val secretsStayRedacted =
    storedSecret != PlainSecret
      and (status.get(ApiKey) == Resolved implies storedSecret == RedactedSecret)
      and (trigger == SecretPayloadRedacted implies storedSecret == RedactedSecret)

  val actionsArePullOnly =
    not(inputFanoutQueuedAction)
      and ACTIONS.intersect(ATOMS).size() == 0
      and (queue.contains(Notify) implies waiters.get(Notify).intersect(Set(Audit, Receipt)).size() > 0)

  val actionsDoNotReexecute =
    notifyEffects <= 1

  val atomErrorsPropagate =
    all {
      status.get(Classify) != Errored
        or status.get(NeedsApproval).in(Set(NotReached, Blocked, Errored)),
      status.get(NeedsApproval) != Errored
        or status.get(HumanPrompt).in(Set(NotReached, Blocked, Errored)),
      status.get(HumanPrompt) != Errored
        or status.get(Notify).in(Set(NotReached, Blocked, Errored)),
      status.get(Notify) != Errored
        or status.get(Audit).in(Set(NotReached, Blocked, Errored))
        or status.get(Receipt).in(Set(NotReached, Blocked, Errored)),
      status.get(Enrich) != Errored
        or status.get(Metrics).in(Set(NotReached, Blocked, Errored)),
    }

  val startedRunsHavePayloads =
    (trigger == NoPayload) == (processed.size() == 0)

  val processedEventsStayValid =
    processed.subseteq(EVENTS)

  val sourceInputChangesDirtyDerivedAtoms =
    SOURCE_TRACKED_ATOMS.forall(stepId =>
      not(isTerminal(status.get(stepId))) or version.get(stepId) == sourceVersion
    )

  val promptCallbacksOnlyResumeFreshRequests =
    all {
      status.get(HumanPromptResponse) != Resolved or version.get(HumanPromptResponse) == sourceVersion,
      status.get(HumanPrompt) != Resolved or sourceRisk != HighRisk or status.get(HumanPromptResponse) == Resolved,
      (processed.contains(PromptStaleApprovalEvent) and version.get(HumanPromptResponse) != sourceVersion)
        implies status.get(HumanPromptResponse) != Resolved,
    }

  val webhookReentryIsIdempotentByEventId =
    processed.contains(WebhookFirst) implies version.get(Webhook) <= sourceVersion

  run slackUrgentWaitsForApprovalAndSecret =
    init
      .then(submitSource(SlackFirst, SlackUrgent))
      .then(processExtractTextResolved)
      .then(processClassifyResolved)
      .then(processNeedsApprovalWaiting)
      .then(submitApprovalGranted)
      .then(processNeedsApprovalApproved)
      .then(processHumanPromptRequest)
      .then(submitPromptApproved)
      .then(processHumanPromptApproved)
      .then(processAuditOrReceiptBlocked)
      .then(processNotifyWaitingForSecret)
      .then(submitSecret)
      .then(processNotifyResolved)
      .then(processAuditResolved)
      .expect(status.get(Audit) == Resolved and notifyEffects == 1)

  run githubLaterRecoversSkippedBranch =
    init
      .then(submitSource(SlackFirst, SlackNormal))
      .then(processReviewSkipped)
      .then(submitSource(GithubFirst, GithubLarge))
      .then(processReviewResolved)
      .expect(status.get(Review) == Resolved and version.get(Review) == sourceVersion)

  run sourceUpdateDirtiesResolvedAtoms =
    init
      .then(submitSource(SlackFirst, SlackNormal))
      .then(processExtractTextResolved)
      .then(processClassifyResolved)
      .then(processNeedsApprovalNormal)
      .then(processHumanPromptNoPrompt)
      .then(submitSource(SlackUpdate, SlackUrgent))
      .expect(status.get(Classify) == NotReached and queue.contains(Classify) and sourceVersion == 2)

  run parallelConsumersDedupNotifyAction =
    init
      .then(submitSource(EmailFirst, EmailNormal))
      .then(processExtractTextResolved)
      .then(processClassifyResolved)
      .then(processNeedsApprovalNormal)
      .then(processHumanPromptNoPrompt)
      .then(processAuditOrReceiptBlocked)
      .then(processAuditOrReceiptBlocked)
      .then(processNotifyWaitingForSecret)
      .then(submitSecret)
      .then(processNotifyResolved)
      .then(processAuditResolved)
      .then(processReceiptResolved)
      .expect(status.get(Audit) == Resolved and status.get(Receipt) == Resolved and notifyEffects == 1)

  run atomErrorPropagatesToActionConsumers =
    init
      .then(submitSource(SlackFirst, SlackNormal))
      .then(processExtractTextResolved)
      .then(processClassifyUnexpectedError)
      .then(processNeedsApprovalErroredFromClassify)
      .then(processHumanPromptErroredFromNeedsApproval)
      .then(processAuditOrReceiptBlocked)
      .then(processNotifyErroredFromNeedsApproval)
      .then(processAuditOrReceiptErrored)
      .expect(status.get(Notify) == Errored and status.get(Audit) == Errored and notifyEffects == 0)

  run humanPromptCallbackResumesWorkflow =
    init
      .then(submitSource(WebhookFirst, WebhookUrgent))
      .then(processExtractTextResolved)
      .then(processClassifyResolved)
      .then(processNeedsApprovalWaiting)
      .then(submitApprovalGranted)
      .then(processNeedsApprovalApproved)
      .then(processHumanPromptRequest)
      .then(submitPromptApproved)
      .then(processHumanPromptApproved)
      .expect(status.get(HumanPrompt) == Resolved and status.get(HumanPromptResponse) == Resolved)

  run staleHumanPromptCallbackIgnoredAfterWebhookReentry =
    init
      .then(submitSource(WebhookFirst, WebhookUrgent))
      .then(processExtractTextResolved)
      .then(processClassifyResolved)
      .then(processNeedsApprovalWaiting)
      .then(submitApprovalGranted)
      .then(processNeedsApprovalApproved)
      .then(processHumanPromptRequest)
      .then(submitSource(WebhookRetry, WebhookUrgent))
      .then(submitStalePromptApproved)
      .expect(status.get(HumanPromptResponse) != Resolved and status.get(HumanPrompt) != Resolved)

  run duplicateWebhookDeliveryIsNoop =
    init
      .then(submitSource(WebhookFirst, WebhookNormal))
      .then(replayWebhookFirst)
      .expect(sourceVersion == 1 and processed.contains(WebhookFirst) and status.get(Webhook) == Resolved)
}
