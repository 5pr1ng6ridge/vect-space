//! The atomic two-window candidate of one host transaction.
//!
//! A player command, a timer callback or a cross-window control request never
//! touches the live runtimes directly.  The host clones both runtimes into a
//! [`Pair`], runs the command, then *settles* the pair: window-control nodes
//! stop their runtime at a host boundary, are applied here in node order
//! (titles, advance blocks, scripted advances, `open_window`), the source then
//! resumes, shared state is mirrored to the other window and both windows'
//! derived state (current choices, interpolated text, blocks) is re-derived.
//! Only when the whole pair is consistent — and the profile write and the native
//! window work have succeeded — is it committed and published.
//!
//! `window_geometry` / `window_layer` requests are validated here (their target
//! windows must exist, in node order, so a request for a window that is not open
//! fails the whole transaction like a title does) and recorded on the pair as
//! [`WindowEffect`]s.  They are *applied* only by the native stage after the
//! commit (see `window_fx.rs`), so a rolled-back pair never moves a window.

use std::{collections::VecDeque, ops::Deref};

use vectspace_core::{
    content::ContentCatalog,
    interaction::{
        WindowControlAction, WindowReference, WindowRequest, WindowRole, WindowTitles,
        DEFAULT_SECONDARY_TITLE,
    },
    model::{
        AdvanceSource, CueGate, PresentationCueKind, PromptSnapshot, RuntimeSnapshot, RuntimeUpdate,
    },
    runtime::RuntimeEngine,
};
use vectspace_protocol::{WireCommandError, WireCommandErrorCode};

use crate::{
    native_plan::SecondaryPlan,
    secondary::{SecondaryOwner, SecondarySession, SECONDARY_ID_STRIDE},
    state::EngineState,
    window_fx::WindowEffect,
};

/// Bound for one transaction's chain of host-control steps.  Reaching it means
/// the authored content ping-pongs control nodes between the windows forever.
pub(crate) const MAX_HOST_STEPS: usize = 64;

/// Which runtime owns the shared Save/Profile maps of the pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Authority {
    /// The player's main story; the profile is persisted from it.
    Story,
    /// An isolated replay; nothing it does is ever persisted.
    Replay { generation: u64 },
}

/// One update the transaction produced for one window, in delivery order.
#[derive(Debug, Clone)]
pub(crate) struct Produced {
    pub role: WindowRole,
    pub update: RuntimeUpdate,
}

/// A committed transaction's deliverable updates.  Dereferences to the update
/// the command's own window gets as its response.
#[derive(Debug, Clone)]
pub(crate) struct Committed {
    pub produced: Vec<Produced>,
    pub own: Option<usize>,
    pub diagnostics: Vec<String>,
    /// Native window effects (geometry, layers) in node order.  They are applied
    /// by the native stage of the transaction, never before the commit.
    pub effects: Vec<WindowEffect>,
}

impl Committed {
    pub(crate) fn from_pair(pair: &mut Pair, origin: Option<WindowRole>) -> Self {
        let produced = std::mem::take(&mut pair.produced);
        let own = origin.and_then(|role| produced.iter().position(|item| item.role == role));
        Self {
            produced,
            own,
            diagnostics: std::mem::take(&mut pair.diagnostics),
            effects: std::mem::take(&mut pair.window_effects),
        }
    }
}

impl Deref for Committed {
    type Target = RuntimeUpdate;

    fn deref(&self) -> &RuntimeUpdate {
        let index = self
            .own
            .expect("this transaction has no origin-window update");
        &self.produced[index].update
    }
}

#[derive(Debug, Clone)]
struct QueuedRequest {
    role: WindowRole,
    /// The Scene the requesting runtime was in when it emitted the request.
    scene: String,
    request: WindowRequest,
}

#[derive(Debug, Clone)]
pub(crate) struct Pair {
    pub authority: Authority,
    /// The main story's (or the replay's) runtime: the `Main` window.
    pub primary: RuntimeEngine,
    /// The secondary window's candidate session, if any.
    pub secondary: Option<SecondarySession>,
    /// A live secondary window existed before this transaction.
    pub live_before: bool,
    /// This transaction created (or re-pointed) the secondary session.
    pub staged: bool,
    /// This transaction closed the secondary window.
    pub hidden: bool,
    /// Replay only: the replay is over, so the window it owns closes.
    pub closing: bool,
    pub replay_ending_before: bool,
    /// A restored slot keeps the owner scene it was saved with.
    pub keep_owner: bool,
    pub produced: Vec<Produced>,
    pub diagnostics: Vec<String>,
    /// Validated native window effects of this candidate, in node order.  Part
    /// of the candidate, so a rolled-back pair carries none of them.
    pub window_effects: Vec<WindowEffect>,
    pending_open: Option<String>,
    queue: VecDeque<QueuedRequest>,
    baseline_main: RuntimeSnapshot,
    baseline_secondary: Option<RuntimeSnapshot>,
    main_scene_before: String,
}

impl Pair {
    pub(crate) fn new(
        authority: Authority,
        primary: RuntimeEngine,
        secondary: Option<SecondarySession>,
        live_before: bool,
    ) -> Self {
        let baseline_main = primary.snapshot().clone();
        let main_scene_before = baseline_main.location.scene_id.clone();
        let baseline_secondary = secondary
            .as_ref()
            .map(|session| session.runtime.snapshot().clone());
        Self {
            authority,
            primary,
            secondary,
            live_before,
            staged: false,
            hidden: false,
            closing: false,
            replay_ending_before: false,
            keep_owner: false,
            produced: Vec::new(),
            diagnostics: Vec::new(),
            window_effects: Vec::new(),
            pending_open: None,
            queue: VecDeque::new(),
            baseline_main,
            baseline_secondary,
            main_scene_before,
        }
    }

    pub(crate) fn runtime(&self, role: WindowRole) -> Option<&RuntimeEngine> {
        match role {
            WindowRole::Main => Some(&self.primary),
            WindowRole::Secondary => self.secondary.as_ref().map(|session| &session.runtime),
        }
    }

    pub(crate) fn runtime_mut(&mut self, role: WindowRole) -> Option<&mut RuntimeEngine> {
        match role {
            WindowRole::Main => Some(&mut self.primary),
            WindowRole::Secondary => self.secondary.as_mut().map(|session| &mut session.runtime),
        }
    }

    pub(crate) fn titles(&self) -> WindowTitles {
        self.primary.snapshot().interaction.titles.clone()
    }

    /// The primary's titles are the authority; the secondary mirrors them.
    pub(crate) fn set_titles(&mut self, titles: WindowTitles) {
        if let Some(session) = self.secondary.as_mut() {
            session.runtime.set_window_titles(titles.clone());
        }
        self.primary.set_window_titles(titles);
    }

    /// Mirror the primary's shared state into the secondary before a command
    /// runs on it, so it never evaluates against a stale copy.
    pub(crate) fn seed_secondary(&mut self) {
        let titles = self.titles();
        if let Some(session) = self.secondary.as_mut() {
            session
                .runtime
                .set_save_variables(self.primary.snapshot().variables.clone());
            session
                .runtime
                .set_profile_variables(self.primary.profile_variables_map().clone());
            session.runtime.set_window_titles(titles);
        }
    }

    /// Record an update produced by a step of `role`'s runtime.  The host-only
    /// `open_window` cue is consumed here, host requests are queued in node
    /// order and the step's shared state is mirrored to the other window.
    pub(crate) fn push(&mut self, role: WindowRole, update: RuntimeUpdate) {
        let update = self.absorb(role, update);
        self.produced.push(Produced { role, update });
        self.collect(role);
        self.after_step(role);
    }

    /// Record the update of a run that was resumed after a host boundary: its
    /// cues join the update of the run it continues, so the window receives one
    /// presentation per command.
    pub(crate) fn push_continuation(&mut self, role: WindowRole, update: RuntimeUpdate) {
        let update = self.absorb(role, update);
        match self
            .produced
            .iter_mut()
            .rev()
            .find(|item| item.role == role)
        {
            Some(previous) => {
                previous.update.cues.extend(update.cues);
                previous.update.snapshot = update.snapshot;
                previous.update.update_id = update.update_id;
                previous.update.requires_ack = update.requires_ack;
            }
            None => self.produced.push(Produced { role, update }),
        }
        self.collect(role);
        self.after_step(role);
    }

    fn absorb(&mut self, role: WindowRole, mut update: RuntimeUpdate) -> RuntimeUpdate {
        // The cue is a host instruction.  A secondary can never open windows.
        let opened = take_open_window_request(&mut update);
        if role == WindowRole::Main {
            if let Some(scene) = opened {
                self.pending_open = Some(scene);
            }
        }
        debug_assert_no_window_cue(&update);
        match role {
            WindowRole::Main => self.baseline_main = update.snapshot.clone(),
            WindowRole::Secondary => self.baseline_secondary = Some(update.snapshot.clone()),
        }
        update
    }

    fn collect(&mut self, role: WindowRole) {
        let Some(runtime) = self.runtime_mut(role) else {
            return;
        };
        let requests = runtime.take_window_requests();
        if requests.is_empty() {
            return;
        }
        let scene = runtime.snapshot().location.scene_id.clone();
        for request in requests {
            self.queue.push_back(QueuedRequest {
                role,
                scene: scene.clone(),
                request,
            });
        }
    }

    /// Mirror one window's shared Save/Profile maps (and the secondary's new
    /// dialogue occurrences) to the other window.
    pub(crate) fn after_step(&mut self, role: WindowRole) {
        match role {
            WindowRole::Main => {
                if let Some(session) = self.secondary.as_mut() {
                    session
                        .runtime
                        .set_save_variables(self.primary.snapshot().variables.clone());
                    session
                        .runtime
                        .set_profile_variables(self.primary.profile_variables_map().clone());
                }
            }
            WindowRole::Secondary => {
                if let Some(session) = self.secondary.as_mut() {
                    self.primary
                        .set_save_variables(session.runtime.snapshot().variables.clone());
                    self.primary
                        .set_profile_variables(session.runtime.profile_variables_map().clone());
                    self.primary
                        .extend_dialogue_history(session.runtime.take_appended_history());
                }
            }
        }
    }

    /// Treat `scene_id` as the Scene this transaction started in (a replay
    /// entry starts at its own Scene, not at the manifest entry).
    pub(crate) fn set_scene_baseline(&mut self, scene_id: &str) {
        self.main_scene_before = scene_id.to_owned();
    }

    /// A restored slot is rejected as a whole when an advance block names a
    /// source window or Scene that does not exist in the restored pair.
    pub(crate) fn validate_restored_interaction(&self) -> Result<(), WireCommandError> {
        let main_scene = self.primary_scene();
        let secondary_scene = self.secondary_scene();
        for target in [WindowRole::Main, WindowRole::Secondary] {
            let Some(runtime) = self.runtime(target) else {
                continue;
            };
            for block in &runtime.snapshot().interaction.blocks {
                let valid = match block.source {
                    WindowRole::Main => block.source_scene == main_scene,
                    WindowRole::Secondary => secondary_scene == Some(block.source_scene.as_str()),
                };
                if !valid {
                    return Err(WireCommandError::new(
                        WireCommandErrorCode::Validation,
                        format!(
                            "存档中的翻页阻挡 {} 的来源窗口或场景 {} 不存在，已拒绝读取",
                            block.id, block.source_scene
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    /// How many host requests of `role` are queued and not yet applied.
    pub(crate) fn queued_requests(&self, role: WindowRole) -> usize {
        self.queue.iter().filter(|item| item.role == role).count()
    }

    pub(crate) fn primary_scene(&self) -> &str {
        &self.primary.snapshot().location.scene_id
    }

    pub(crate) fn main_scene_changed(&self) -> bool {
        self.primary_scene() != self.main_scene_before
    }

    /// Close the secondary window and drop everything it produced.  Blocks the
    /// closed window had placed on the main window go with it, and the window's
    /// title resets.
    pub(crate) fn hide_secondary(&mut self) {
        if self.secondary.take().is_none() {
            return;
        }
        self.hidden = true;
        self.drop_old_secondary_output();
        self.clear_source_blocks(WindowRole::Secondary);
        let mut titles = self.titles();
        titles.secondary.clear();
        self.primary.set_window_titles(titles);
    }

    /// A replay that ends in the same update that opened a window never shows
    /// it: take the staged session back.
    pub(crate) fn unstage(&mut self) {
        if !self.staged {
            return;
        }
        self.secondary = None;
        self.staged = false;
        self.hidden = self.live_before;
        self.drop_old_secondary_output();
        self.clear_source_blocks(WindowRole::Secondary);
        let mut titles = self.titles();
        titles.secondary.clear();
        self.primary.set_window_titles(titles);
    }

    fn drop_old_secondary_output(&mut self) {
        self.produced
            .retain(|item| item.role != WindowRole::Secondary);
        self.queue.retain(|item| item.role != WindowRole::Secondary);
        // Effects aimed at the window that is going away (or being replaced)
        // belong to it: the story that sent them no longer has that window.
        self.window_effects
            .retain(|effect| effect.target() != WindowRole::Secondary);
    }

    /// Remove every advance block placed by `source`, wherever it sits.
    fn clear_source_blocks(&mut self, source: WindowRole) {
        for target in [WindowRole::Main, WindowRole::Secondary] {
            let Some(runtime) = self.runtime_mut(target) else {
                continue;
            };
            let scenes: Vec<String> = runtime
                .snapshot()
                .interaction
                .blocks
                .iter()
                .filter(|block| block.source == source)
                .map(|block| block.source_scene.clone())
                .collect();
            for scene in scenes {
                runtime.clear_blocks_from(source, &scene);
            }
        }
    }

    fn secondary_scene(&self) -> Option<&str> {
        self.secondary
            .as_ref()
            .map(|session| session.runtime.snapshot().location.scene_id.as_str())
    }

    /// Advance blocks live only while the window that created them is still in
    /// the Scene that created them.  Blocks of a departed source — and any block
    /// whose source window no longer exists — are removed.  (A *replaced* window
    /// loses its blocks when it is replaced, see [`Self::clear_source_blocks`].)
    fn sweep_blocks(&mut self) {
        let main_scene = self.primary_scene().to_owned();
        let secondary_scene = self.secondary_scene().map(str::to_owned);
        let mut stale: Vec<(WindowRole, WindowRole, String)> = Vec::new();
        for target in [WindowRole::Main, WindowRole::Secondary] {
            let Some(runtime) = self.runtime(target) else {
                continue;
            };
            for block in &runtime.snapshot().interaction.blocks {
                let valid = match block.source {
                    WindowRole::Main => block.source_scene == main_scene,
                    WindowRole::Secondary => {
                        secondary_scene.as_deref() == Some(block.source_scene.as_str())
                    }
                };
                if !valid {
                    stale.push((target, block.source, block.source_scene.clone()));
                }
            }
        }
        for (target, source, scene) in stale {
            if let Some(runtime) = self.runtime_mut(target) {
                runtime.clear_blocks_from(source, &scene);
            }
        }
    }

    /// Re-derive both windows' current prompt from the settled shared state and
    /// emit a `state_refresh` for every window whose derived state changed since
    /// its last delivered snapshot.
    fn refresh_roles(&mut self, content: &ContentCatalog) -> Result<(), WireCommandError> {
        for role in [WindowRole::Main, WindowRole::Secondary] {
            let baseline = match role {
                WindowRole::Main => Some(self.baseline_main.clone()),
                WindowRole::Secondary => self.baseline_secondary.clone(),
            };
            let Some(runtime) = self.runtime_mut(role) else {
                continue;
            };
            runtime
                .refresh_prompt(content)
                .map_err(WireCommandError::from)?;
            let changed = baseline
                .as_ref()
                .is_none_or(|baseline| !derived_equal(baseline, runtime.snapshot()));
            if !changed {
                continue;
            }
            let update = runtime
                .refresh_update(content)
                .map_err(WireCommandError::from)?;
            match role {
                WindowRole::Main => self.baseline_main = update.snapshot.clone(),
                WindowRole::Secondary => self.baseline_secondary = Some(update.snapshot.clone()),
            }
            self.produced.push(Produced { role, update });
        }
        Ok(())
    }
}

/// Consume the host control cues from an update.  The cue is a host instruction,
/// not a presentation instruction: it must never reach a WebView, and it must be
/// consumed exactly once so a frontend retry cannot re-trigger the side effect.
///
/// One update can carry several requests because the runtime keeps going past
/// every `open_window` node, and a repeated `open_window` replaces the single
/// slot: the **last** request in the update is therefore the one that decides
/// what the window shows.  The intermediate requests are deliberately not
/// played — no intermediate secondary runtime is ever created.
///
/// The acknowledgement requirement is recomputed from the cues that remain,
/// because the runtime derives it from its own (pre-strip) cue list: an
/// `open_window` followed by a runtime-gated node such as `wait` is a valid
/// authored combination, and it must keep exactly the acknowledgement its
/// remaining presentation still needs.
pub(crate) fn take_open_window_request(update: &mut RuntimeUpdate) -> Option<String> {
    let mut requested = None;
    let requires_ack_before = update.requires_ack;
    update.cues.retain(|cue| {
        if let PresentationCueKind::OpenWindow { scene } = &cue.kind {
            requested = Some(scene.clone());
            false
        } else {
            true
        }
    });
    let requires_ack = update.cues.iter().any(|cue| cue.gate == CueGate::Runtime);
    debug_assert!(
        !requires_ack_before || requires_ack || requested.is_none(),
        "stripping a control cue must not drop the acknowledgement a remaining presentation needs"
    );
    update.requires_ack = requires_ack;
    requested
}

/// The host-only window cue must never survive into an update that a WebView
/// receives.  Every host path that returns an update asserts this in debug
/// builds, so a new producer that forgets to consume the cue fails loudly in
/// tests instead of silently turning the node into a no-op at the wire boundary.
pub(crate) fn debug_assert_no_window_cue(update: &RuntimeUpdate) {
    debug_assert!(
        !update
            .cues
            .iter()
            .any(|cue| matches!(cue.kind, PresentationCueKind::OpenWindow { .. })),
        "宿主控制提示必须在下发到 WebView 之前被消费"
    );
}

/// Snapshot equality that ignores everything that is *not* player-visible
/// derived state: the revision counter and the timers' remaining time.
pub(crate) fn derived_equal(left: &RuntimeSnapshot, right: &RuntimeSnapshot) -> bool {
    let mut left = left.clone();
    let mut right = right.clone();
    right.revision = left.revision;
    for timer in left.interaction.timers.values_mut() {
        timer.remaining_ms = 0;
    }
    for timer in right.interaction.timers.values_mut() {
        timer.remaining_ms = 0;
    }
    left == right
}

fn missing_window(role: WindowRole, scene: &str, what: &str) -> WireCommandError {
    let window = match role {
        WindowRole::Main => "主窗口",
        WindowRole::Secondary => "副窗口",
    };
    WireCommandError::new(
        WireCommandErrorCode::Runtime,
        format!("{what}: 目标{window}不存在（来自场景 {scene}），请先用 open_window 打开副窗口"),
    )
}

impl EngineState {
    /// Settle a pair: apply every queued host request in node order, resume
    /// the runtimes that stopped at a host boundary and stage `open_window`
    /// before any later request can address the new window.
    pub(crate) fn settle(&self, pair: &mut Pair) -> Result<(), WireCommandError> {
        for _ in 0..MAX_HOST_STEPS {
            if let Some(scene) = pair.pending_open.take() {
                self.stage_open(pair, &scene)?;
                continue;
            }
            if let Some(queued) = pair.queue.pop_front() {
                self.apply_request(pair, queued)?;
                continue;
            }
            let waiting = [WindowRole::Main, WindowRole::Secondary]
                .into_iter()
                .find(|role| {
                    pair.runtime(*role)
                        .is_some_and(RuntimeEngine::at_host_boundary)
                });
            let Some(role) = waiting else {
                return Ok(());
            };
            let update = pair
                .runtime_mut(role)
                .expect("a waiting runtime exists")
                .resume_after_host(&self.content)
                .map_err(WireCommandError::from)?;
            pair.push_continuation(role, update);
        }
        Err(WireCommandError::new(
            WireCommandErrorCode::Runtime,
            format!("窗口控制节点链超过 {MAX_HOST_STEPS} 步，疑似内容循环"),
        ))
    }

    fn apply_request(
        &self,
        pair: &mut Pair,
        queued: QueuedRequest,
    ) -> Result<(), WireCommandError> {
        let QueuedRequest {
            role,
            scene,
            request,
        } = queued;
        match request {
            WindowRequest::Title { target, title } => {
                if pair.runtime(target).is_none() {
                    return Err(missing_window(target, &scene, "window_title"));
                }
                let mut titles = pair.titles();
                titles.set(target, title);
                pair.set_titles(titles);
            }
            WindowRequest::Control {
                target,
                action,
                id,
                message,
            } => {
                let Some(runtime) = pair.runtime_mut(target) else {
                    return Err(missing_window(target, &scene, "window_control"));
                };
                match action {
                    WindowControlAction::Block | WindowControlAction::Unblock => {
                        runtime.control_block(role, &scene, action, &id, &message);
                    }
                    WindowControlAction::Advance => {
                        // A scripted advance is one page turn: it neither picks a
                        // Choice nor queues itself for a future dialogue nor lifts
                        // a block.  A target that cannot page right now is left
                        // alone.
                        if runtime.can_script_advance() {
                            let revision = runtime.snapshot().revision;
                            let update = runtime
                                .advance(&self.content, revision, AdvanceSource::Script)
                                .map_err(WireCommandError::from)?;
                            pair.push(target, update);
                        }
                    }
                }
            }
            WindowRequest::Geometry {
                target,
                position,
                size,
                duration_ms,
                easing,
            } => {
                if pair.runtime(target).is_none() {
                    return Err(missing_window(target, &scene, "window_geometry"));
                }
                // A placement relative to the other window needs that window
                // too, or the node would silently turn into something else.
                if position
                    .is_some_and(|placement| placement.relative_to == WindowReference::Window)
                {
                    let other = match target {
                        WindowRole::Main => WindowRole::Secondary,
                        WindowRole::Secondary => WindowRole::Main,
                    };
                    if pair.runtime(other).is_none() {
                        return Err(missing_window(other, &scene, "window_geometry"));
                    }
                }
                pair.window_effects.push(WindowEffect::Geometry {
                    target,
                    position,
                    size,
                    duration_ms,
                    easing,
                });
            }
            WindowRequest::Layer { target, action } => {
                if pair.runtime(target).is_none() {
                    return Err(missing_window(target, &scene, "window_layer"));
                }
                pair.window_effects
                    .push(WindowEffect::Layer { target, action });
            }
        }
        Ok(())
    }

    /// Create (or re-point) the secondary session for `scene_id`.  The previous
    /// candidate session — and everything it produced in this transaction —
    /// belongs to the old window and is discarded.
    fn stage_open(&self, pair: &mut Pair, scene_id: &str) -> Result<(), WireCommandError> {
        let target = self.content.scenes.get(scene_id).ok_or_else(|| {
            WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("open_window 指向未声明的场景 {scene_id}"),
            )
        })?;
        if target.window_role != WindowRole::Secondary {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("open_window 目标 {scene_id} 不是副窗口专用 Scene，请设置其用途"),
            ));
        }
        let owning_scene = pair.primary_scene().to_owned();
        if self
            .content
            .scenes
            .get(&owning_scene)
            .is_some_and(|scene| scene.window_role != WindowRole::Main)
        {
            return Err(WireCommandError::new(
                WireCommandErrorCode::Validation,
                format!("open_window 只能由主窗口 Scene 发起，{owning_scene} 不是主窗口用途"),
            ));
        }
        let token = self.bump_secondary_generation()?;
        let id_base = token.checked_mul(SECONDARY_ID_STRIDE).ok_or_else(|| {
            WireCommandError::new(WireCommandErrorCode::Internal, "副窗口编号耗尽")
        })?;
        let owner = match pair.authority {
            Authority::Story => SecondaryOwner::Story {
                scene_id: owning_scene,
            },
            Authority::Replay { generation } => SecondaryOwner::Replay { generation },
        };
        // A brand new window starts with the default title; the previous window's
        // title never carries over to its replacement.
        let mut titles = pair.titles();
        titles.secondary = DEFAULT_SECONDARY_TITLE.to_owned();
        pair.drop_old_secondary_output();
        // Blocks the replaced window had placed on the main window vanish with it.
        pair.clear_source_blocks(WindowRole::Secondary);
        pair.secondary = None;
        pair.primary.set_window_titles(titles.clone());
        let (session, first) =
            self.build_secondary_session(&pair.primary, scene_id, owner, token, id_base, titles)?;
        pair.secondary = Some(session);
        pair.baseline_secondary = None;
        pair.staged = true;
        pair.hidden = false;
        pair.push(WindowRole::Secondary, first);
        Ok(())
    }

    /// Final consistency pass over a settled pair: window lifecycle, advance
    /// blocks, mirrored titles and re-derived prompts.
    pub(crate) fn finish_pair(
        &self,
        pair: &mut Pair,
        force_hide: bool,
    ) -> Result<(), WireCommandError> {
        pair.closing = false;
        let ended = matches!(pair.primary.snapshot().prompt, PromptSnapshot::End { .. });
        let replay = matches!(pair.authority, Authority::Replay { .. });
        if replay {
            // A replay closes the window it owns when it leaves its Scene or is
            // over, and a window opened by that very update is never shown.
            pair.closing = pair.replay_ending_before || ended || pair.main_scene_changed();
            if pair.closing {
                pair.unstage();
            }
        }
        // Leaving the owning Scene (or a host-forced boundary) closes a window
        // this transaction did not just open: an `open_window` in the same
        // update wins, because the Scene the update lands in owns its window.
        if !pair.staged
            && pair.secondary.is_some()
            && (force_hide || pair.closing || pair.main_scene_changed())
        {
            pair.hide_secondary();
        }
        if pair.staged {
            if let (Authority::Story, false, Some(session)) =
                (pair.authority, pair.keep_owner, pair.secondary.as_mut())
            {
                // The Scene an update lands in owns the window it asked for.
                session.owner = SecondaryOwner::Story {
                    scene_id: pair.primary.snapshot().location.scene_id.clone(),
                };
            }
        }
        pair.sweep_blocks();
        let titles = pair.titles();
        pair.set_titles(titles);
        pair.refresh_roles(&self.content)?;
        if let Some(session) = pair.secondary.as_mut() {
            session.scene_id = session.runtime.snapshot().location.scene_id.clone();
        }
        Ok(())
    }

    /// Everything the secondary window must hold after `plan` for the plan to
    /// be a faithful description of the pair.
    pub(crate) fn plan_for(&self, pair: &Pair) -> SecondaryPlan {
        if pair.staged {
            SecondaryPlan::Show {
                replaced: pair.live_before,
            }
        } else if pair.live_before && pair.secondary.is_none() {
            SecondaryPlan::Hide
        } else {
            SecondaryPlan::None
        }
    }
}
