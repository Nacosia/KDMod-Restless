/*
 * 无法安宁 / Restless (KDRestless) v1 -- Kinky Dungeon 5.5.6 mod
 *
 * 作用
 * ----
 * 玩家闲置一段时间后，mod 会自动替他"原地等待一回合"，让时间继续流动；
 * 等待间隔由体力驱动：体力越低，时间走得越快（也可反向或纯线性/纯阶段）。
 *
 * 实现（全部使用引擎自己的调用，与 vanilla 自动等待一致）
 * ------------------------------------------------------
 * 1. 包裹 KinkyDungeonDrawGame()：引擎每帧在 KinkyDungeonState === "Game" 时调用它
 *    （Scripts/Drawing.ts:197 DrawProcess -> KinkyDungeon.ts:1548 KinkyDungeonRun -> 3126）。
 *    包裹后先跑原函数，再跑一次 tick()。
 * 2. tick 里若"距上次消耗回合已超过间隔"且引擎空闲，就发一个零方向 move 输入：
 *    与 KinkyDungeon.ts:3229 的 vanilla 自动等待完全相同，最终走到
 *    KinkyDungeonMove({0,0}) -> KinkyDungeonWaitMessage() + KinkyDungeonAdvanceTime(1)
 *    （KinkyDungeonGame.ts:3280-3287）。
 * 3. 额外的定时器兜底：若帧钩子没有生效（例如被别的 mod 覆盖），每 100ms 的定时器会接管，
 *    但只在页面可见、且帧钩子确实没在跑的时候才推进，避免后台偷偷跳回合。
 * 4. 左下角有一个 DOM 状态面板：实时显示"是否在游戏中 / 体力 / 当前间隔 /
 *    倒计时 / 已推进回合数 / 当前为什么暂停"。面板能显示 = mod 一定被执行了；
 *    面板不显示 = mod 根本没被加载（安装/刷新问题，不是脚本逻辑问题）。
 * 5. vanilla 的 "You wait" 文本只对我们强制产生的等待静默，其它情况不动。
 *
 * 安全
 * ----
 * 菜单/弹窗/对话/物品栏/目标选择/输入队列未清空/其它自动模式接管/睡眠/冻结/缓慢移动/
 * 延迟动作/存档中/站在楼梯上/站在可交互物体上 —— 一律不推进，并在面板上显示原因。
 * 任何异常都只跳过当前 tick 并写 console，绝不让异常冒到引擎帧循环里。
 *
 */
(function () {
	"use strict";

	var MOD_ID = "KDRestless";
	var VERSION = 1;
	var LOG_PREFIX = "[Restless]";

	// ------------------------------------------------------------------ 文本

	/** 取一条界面文字；缺键时返回文本键本身（与引擎 ModCompat 的缺键行为一致）。 */
	function say(key, params) {
		try {
			if (typeof TextGet === "function") return TextGet(key, params);
		} catch (_e) { /* ignore */ }
		return key;
	}

	/**
	 * 全部界面文字的英文默认值（中文由 Restless_CN.csv 覆盖）。
	 * 文本键一律 KDRL 开头，不会撞到本体词条；带 ${名字} 的是模板，取值时传 params。
	 */
	var TEXT_KEYS = {
		// Mod 名与配置页
		KDRLModName: "Restless",
		KDModButtonKDRestless: "Restless",
		KDModButtonKDRLEnabled: "Enable auto-advance",
		KDModButtonKDRLIndicator: "On-screen indicator",
		KDModButtonKDRLQuiet: "Quiet mode (only near the moment)",
		KDModButtonKDRLMode: "Stamina curve mode",
		KDModButtonKDRLBaseInterval: "Base interval (ms)",
		KDModButtonKDRLLinear: "Linear strength (0-1)",
		KDModButtonKDRLStage: "Stage strength (0-1)",
		KDModButtonKDRLMinInterval: "Min interval (ms)",
		KDModButtonKDRLMaxInterval: "Max interval (ms)",
		KDModButtonKDRLInspectSlow: "Inspect slowdown (0 = pause)",
		KDModButtonKDRLAimSlow: "Aim slowdown (0 = pause)",
		KDModButtonKDRLPolarity: "Pacing direction",
		KDModButtonKDRLJitter: "Interval jitter (0-0.3)",
		KDModButtonKDRLNotify: "Stage change notice",
		KDModButtonKDRLShowHud: "Debug panel (large status block)",
		KDModButtonKDRLDebug: "Console debug log",
		KDModButtonKDRLDiag: "Detailed diagnostics",

		// 列表选项（显示值随语言变，逻辑只认 OPTION_IDS）
		KDRLIndicatorRing: "Ring (under feet)",
		KDRLIndicatorFootBar: "Bar (under feet)",
		KDRLIndicatorHeadBar: "Bar (above head)",
		KDRLIndicatorOff: "Off",
		KDRLQuietAlways: "Off (always show)",
		KDRLQuietLast3: "Only in the last 3 s",
		KDRLQuietLast5: "Only in the last 5 s",
		KDRLQuietStamina25: "Only below 25% stamina",
		KDRLQuietEither: "Low stamina or last 3 s",
		KDRLModeLinear: "Linear",
		KDRLModeStaged: "Staged",
		KDRLModeCombined: "Combined",
		KDRLPolarityTiredFast: "Faster when tired",
		KDRLPolarityTiredSlow: "Slower when tired",

		// 行动提示
		KDRLStartNotice: "Time moves on...",
		KDRLStageCalm: "Time drifts by...",
		KDRLStageSteady: "The dungeon keeps an easy pace.",
		KDRLStageTense: "The pace is tightening. Better not stop.",
		KDRLStageUrgent: "Time is pressing you. No more dawdling.",
		KDRLStageCritical: "Every moment counts now!",

		// 阶段名（面板用）
		KDRLStageNameCalm: "Calm",
		KDRLStageNameSteady: "Steady",
		KDRLStageNameTense: "Tense",
		KDRLStageNameUrgent: "Urgent",
		KDRLStageNameCritical: "Critical",
		KDRLStageNameNone: "—",

		// 暂停原因
		KDRLReasonInit: "Initialising",
		KDRLReasonDisabled: "Auto-advance is switched off in settings",
		KDRLReasonNotGame: "Not in game",
		KDRLReasonSubscreen: "A sub-screen is open",
		KDRLReasonNoData: "Map / player data not ready",
		KDRLReasonControls: "Controls disabled (dialog, message overlay, ...)",
		KDRLReasonModal: "A modal / popup is open",
		KDRLReasonDialog: "In a dialog",
		KDRLReasonInventory: "Inventory / targeting / inspecting",
		KDRLReasonInput: "Input queue not empty",
		KDRLReasonAutoWait: "Another auto mode is driving turns",
		KDRLReasonSleep: "Sleeping",
		KDRLReasonFreeze: "Frozen, cannot act",
		KDRLReasonSlow: "Slow movement",
		KDRLReasonDelayed: "Delayed action resolving",
		KDRLReasonSave: "Saving",
		KDRLReasonStairs: "On stairs (auto-descend blocked)",
		KDRLReasonObject: "On an interactable object / mechanism",
		KDRLReasonCountdown: "Counting down",
		KDRLReasonIdle: "Just acted, restarting the timer",
		KDRLReasonInspectPause: "Inspect mode (multiplier 0, paused by setting)",
		KDRLReasonAimPause: "Aiming (multiplier 0, paused by setting)",
		KDRLReasonError: "Internal error, auto-advance paused",
		KDRLReasonNoMove: "Last wait spent no turn (input swallowed)",

		// 暂停原因的补充说明（引擎原始标识符不翻译，直接显示）
		KDRLDetailMapSize: "map size",
		KDRLDetailPlayerEntity: "player entity",
		KDRLDetailPlayerCoords: "player coords ${pos}",
		KDRLDetailMessageOverlay: "message overlay",
		KDRLDetailInventory: "inventory",
		KDRLDetailContainer: "container action",
		KDRLDetailAttackConfirm: "attack confirm",
		KDRLDetailAutoWait: "auto wait",
		KDRLDetailAutoStruggle: "auto struggle",
		KDRLDetailDelayedAutoWait: "delayed auto wait",
		KDRLDetailFastMove: "fast move",
		KDRLDetailFastStruggle: "fast struggle",
		KDRLDetailStairsConfirm: "stairs confirm",
		KDRLDetailMissingEngineFn: "missing engine function ${name}",

		// 慢放名
		KDRLSlowInspect: "Inspect slowdown",
		KDRLSlowAim: "Aim slowdown",

		// 左下角状态面板
		KDRLPanelTitle: "Restless v${ver}",
		KDRLPanelRunning: "● Running",
		KDRLPanelPaused: "● Paused",
		KDRLPanelOff: "○ Off",
		KDRLPanelLoadedScreen: "Loaded · screen: ${screen}",
		KDRLPanelScreenLine: "Screen: in game    Driver: ${driver}",
		KDRLPanelDriverNone: "not started",
		KDRLPanelDriverNotGame: "— (not in game)",
		KDRLPanelDriverWaiting: "frame hook (waiting for the first frame)",
		KDRLPanelDriverFrame: "frame hook",
		KDRLPanelDriverTimer: "interval fallback",
		KDRLPanelDriverFrameDead: "frame hook (not firing)",
		KDRLPanelStateUnknown: "unknown",
		KDRLPanelStaminaLine: "Stamina: ${value}    Stage: ${stage}",
		KDRLPanelStaminaValue: "${cur} / ${max} (${pct}%)",
		KDRLPanelStaminaUnreadable: "unreadable (not in game?)",
		KDRLPanelIntervalLine: "Interval: ${interval}    Mode: ${mode} (${polarity})",
		KDRLPanelCountdownLine: "Countdown: ${value}",
		KDRLPanelCountdownValue: "${elapsed} / ${total} s",
		KDRLPanelAdvances: "Auto-advanced ${count} turns (${attempts} attempts)${ago}",
		KDRLPanelAgo: " (${sec} s ago)",
		KDRLPanelNever: " (none yet)",
		KDRLPanelPause: "⏸ ${text}",
		KDRLPanelDetail: " (${text})",
		KDRLPanelRetry: "Last wait had no effect, retrying",
		KDRLPanelSlowLine: "🐢 ${name} ×${mult} (normal ${base} ms, now ${now} ms)",
		KDRLPanelCompactNote: "The timer starts in game (this panel means the mod ran)",
		KDRLPanelEngineLine: "Engine: ${state} · map ${map} · turn ${turn} · stamina ${stamina}",
		KDRLPanelPlayerLine: "Player: ${player} · input queue ${queue} · autoWait ${autoWait}",
	};

	/**
	 * 列表型设置：每项一个文本键 + 一个稳定 id（两者下标一一对应）。
	 * 引擎的列表控件只认"存下来的显示值"（KDDrawModConfigs 直接打印它），
	 * 所以显示值随语言变、存进 KDModSettings 的也是显示值，逻辑一律用 id。
	 */
	var OPTION_KEYS = {
		KDRLIndicator: ["KDRLIndicatorRing", "KDRLIndicatorFootBar", "KDRLIndicatorHeadBar", "KDRLIndicatorOff"],
		KDRLQuiet: ["KDRLQuietAlways", "KDRLQuietLast3", "KDRLQuietLast5", "KDRLQuietStamina25", "KDRLQuietEither"],
		KDRLMode: ["KDRLModeLinear", "KDRLModeStaged", "KDRLModeCombined"],
		KDRLPolarity: ["KDRLPolarityTiredFast", "KDRLPolarityTiredSlow"],
	};
	var OPTION_IDS = {
		KDRLIndicator: ["ring", "footbar", "bar", "off"],
		KDRLQuiet: ["always", "last3", "last5", "stamina25", "either"],
		KDRLMode: ["linear", "staged", "combined"],
		KDRLPolarity: ["tired_fast", "tired_slow"],
	};
	/**
	 * 旧版本存过的值：内部英文写法 + 历史中文显示值。
	 * 这些只用于读存档，从不显示，所以固定在代码里，换语言后依然认得出来。
	 */
	var OPTION_LEGACY = {
		KDRLIndicator: {
			ring: ["ring", "环形（脚下）"],
			footbar: ["footbar", "脚下进度条", "进度条（脚下）"],
			bar: ["bar", "进度条", "进度条（头顶）"],
			off: ["off", "none", "关闭"],
		},
		KDRLQuiet: {
			always: ["always", "关闭（始终显示）"],
			last3: ["last3", "quiet3", "最后 3 秒才出现"],
			last5: ["last5", "quiet5", "最后 5 秒才出现"],
			stamina25: ["stamina25", "只在体力低于 25% 时出现"],
			either: ["either", "体力低或最后 3 秒（任一触发）"],
		},
		KDRLMode: { linear: ["linear", "线性"], staged: ["staged", "阶段"], combined: ["combined", "组合"] },
		KDRLPolarity: { tired_fast: ["tired_fast", "低体力更快"], tired_slow: ["tired_slow", "低体力更慢"] },
	};

	var optionCache = {};

	/** 当前语言的选项文字（顺序同 OPTION_IDS）；文本表变了（CSV 加载完）会自动重取。 */
	function optionLabels(key) {
		var keys = OPTION_KEYS[key];
		var probe = say(keys[0]);
		var cached = optionCache[key];
		if (cached && cached.probe === probe) return cached.labels;
		var labels = [];
		for (var i = 0; i < keys.length; i++) labels.push(say(keys[i]));
		optionCache[key] = { probe: probe, labels: labels };
		return labels;
	}

	/** 存下来的值（当前语言显示值或旧英文写法）-> 稳定 id；认不出来返回 null。 */
	function optionId(key, value) {
		if (value === undefined || value === null) return null;
		var ids = OPTION_IDS[key];
		var legacy = OPTION_LEGACY[key];
		var i, j;
		for (i = 0; i < ids.length; i++) {
			var aliases = legacy[ids[i]];
			for (j = 0; j < aliases.length; j++) {
				if (aliases[j] === value) return ids[i];
			}
		}
		var labels = optionLabels(key);
		for (i = 0; i < labels.length; i++) {
			if (labels[i] === value) return ids[i];
		}
		return null;
	}

	/** 稳定 id -> 当前语言的显示值。 */
	function optionLabel(key, id) {
		var index = OPTION_IDS[key].indexOf(id);
		return optionLabels(key)[index >= 0 ? index : 0];
	}

	/** 局外（Options -> Mod Configuration）可调的默认值；列表型存的是稳定 id。 */
	var DEFAULTS = {
		KDRLEnabled: true,
		/** 屏幕指示器：ring（脚下环）/ footbar（脚下条）/ bar（头顶条）/ off（关闭） */
		KDRLIndicator: "ring",
		/** 安静模式：always = 始终显示；其余只在临近推进或体力见底时浮现。 */
		KDRLQuiet: "always",
		KDRLMode: "combined",
		KDRLBaseInterval: 4000,
		KDRLLinear: 0.55,
		KDRLStage: 1.0,
		KDRLMinInterval: 1500,
		KDRLMaxInterval: 9000,
		/** 检视模式（自由镜头查看）下的等待倍数：0 = 暂停，1 = 正常，6 = 慢六倍。 */
		KDRLInspectSlow: 6,
		/** 施法瞄准状态下的等待倍数：0 = 暂停，1 = 正常，3 = 慢三倍。 */
		KDRLAimSlow: 3,
		KDRLPolarity: "tired_fast",
		KDRLJitter: 0.1,
		KDRLNotify: true,
		/** 大面板（调试用）：日常游玩默认关闭。 */
		KDRLShowHud: false,
		KDRLDebug: true,
		/** 在面板上多显示两行引擎原始状态（排查用，默认开）。 */
		KDRLDiag: true,
	};

	/** 指示器颜色：和阶段一一对应（冷 → 暖 → 红）。 */
	var INDICATOR_COLORS = ["#9ec7e8", "#a8d99a", "#ffd166", "#ff9f43", "#ff6b6b"];

	/** "子弹时间"的安全上限：再慢也不让一回合拖过 2 分钟。 */
	var SLOW_CAP_MS = 120000;

	/**
	 * 阶段曲线。索引 0 = 从容（间隔长）… 4 = 危急（间隔短）。
	 * 阈值取体力比例，对齐游戏自己的关键点：0.95（LikeTheWind）、0.75、0.50 / 0.25
	 * （低体力表情与敌人行为），即初始 10 点体力的 5 / 2.5 / 1 点。
	 */
	var STAGE_THRESHOLDS = [0.95, 0.75, 0.50, 0.25];
	var STAGE_FACTORS = [1.20, 1.00, 0.85, 0.70, 0.55];
	var STAGE_KEYS = [
		"KDRLStageCalm",
		"KDRLStageSteady",
		"KDRLStageTense",
		"KDRLStageUrgent",
		"KDRLStageCritical",
	];
	var STAGE_NAME_KEYS = [
		"KDRLStageNameCalm",
		"KDRLStageNameSteady",
		"KDRLStageNameTense",
		"KDRLStageNameUrgent",
		"KDRLStageNameCritical",
	];
	var STAGE_COLORS = ["#bfbfbf", "#d8d8d8", "#ffe066", "#ffa94d", "#ff6b6b"];

	/** 暂停原因代码 -> 文本键（代码本身写进诊断快照与日志，保持可检索）。 */
	var REASON_KEYS = {
		init: "KDRLReasonInit",
		disabled: "KDRLReasonDisabled",
		notgame: "KDRLReasonNotGame",
		subscreen: "KDRLReasonSubscreen",
		nodata: "KDRLReasonNoData",
		controls: "KDRLReasonControls",
		modal: "KDRLReasonModal",
		dialog: "KDRLReasonDialog",
		inventory: "KDRLReasonInventory",
		input: "KDRLReasonInput",
		autowait: "KDRLReasonAutoWait",
		sleep: "KDRLReasonSleep",
		freeze: "KDRLReasonFreeze",
		slow: "KDRLReasonSlow",
		delayed: "KDRLReasonDelayed",
		save: "KDRLReasonSave",
		stairs: "KDRLReasonStairs",
		object: "KDRLReasonObject",
		countdown: "KDRLReasonCountdown",
		idle: "KDRLReasonIdle",
		inspectPause: "KDRLReasonInspectPause",
		aimPause: "KDRLReasonAimPause",
		error: "KDRLReasonError",
		nomove: "KDRLReasonNoMove",
	};

	function reasonText(code) {
		var key = REASON_KEYS[code];
		return key ? say(key) : String(code);
	}

	function stageName(index) {
		var key = STAGE_NAME_KEYS[index];
		return say(key || "KDRLStageNameNone");
	}

	var state = {
		/** 上一帧是否处于"允许推进"的状态。 */
		active: false,
		/** 本轮倒计时的起点（毫秒时间戳）。 */
		lastAdvance: 0,
		/** 当前这一拍的间隔（毫秒）。 */
		interval: 0,
		/** 未乘"子弹时间"倍数的基准间隔（毫秒）。 */
		baseInterval: 0,
		/** 当前生效的"子弹时间"倍数（1 = 正常速度）。 */
		mult: 1,
		/** 当前的软暂停模式："inspect" / "aim" / ""（无）。 */
		slowKind: "",
		/** 用来识别换层 / 换局的 KDMapData 引用。 */
		mapRef: null,
		/** 上次播报过的阶段，-1 = 还没播报。 */
		stage: -1,
		/** 正在处理我们自己的强制等待时置真（用于静默等待文本）。 */
		suppressWaitMsg: false,
		/** 每次开局播报一次"时间开始流动"。 */
		noticePending: true,
		/** 上一次看到的回合计数（KinkyDungeonCurrentTick）。 */
		lastTick: null,
		/** 错误日志限流。 */
		lastErrorAt: 0,
		/** 引擎钩子是否齐全。 */
		ready: false,

		/** 当前的暂停原因代码（对应 REASON_KEYS）。 */
		reason: "init",
		/** 原因补充说明（例如当前界面名）。 */
		reasonDetail: "",
		/** 上一次写进控制台的原因，避免刷屏。 */
		lastLoggedReason: "",
		/** 已自动推进的回合数。 */
		advanceCount: 0,
		/** 尝试推进的次数。 */
		attempts: 0,
		/** 最近一次成功推进的时间。 */
		lastAdvanceAt: 0,
		/** 最近一次尝试是否没生效。 */
		lastAttemptFailed: false,

		/** 帧钩子最近一次执行的时刻。 */
		lastFrameAt: 0,
		/** 原版 DrawGame 最近一次抛错的时刻（此时不再让兜底驱动推进）。 */
		lastDrawErrorAt: 0,
		/** 帧钩子是否安装成功。 */
		frameHookOk: false,
		/** 当前驱动方式（用于面板显示）。 */
		driver: "none",
		/** 定时器句柄。 */
		timer: null,

		/** HUD 节点缓存。 */
		hudEl: null,
		hudNodes: null,
		lastHudAt: 0,
		/** 最近一次写 localStorage 诊断快照的时刻。 */
		lastSnapshotAt: 0,
		/** 防止 tick 重入。 */
		inTick: false,
		/** 脚本被执行的时刻。 */
		loadedAt: 0,
	};

	// ------------------------------------------------------------------ 基础工具

	/** 当前时间（毫秒）。优先用引擎的 CommonTime()，方便与游戏时钟一致；缺失时退回 Date.now()。 */
	function now() {
		try {
			if (typeof CommonTime === "function") {
				var t = CommonTime();
				if (typeof t === "number" && isFinite(t)) return t;
			}
		} catch (_e) { /* ignore */ }
		return Date.now();
	}

	function clamp(value, low, high) {
		if (!(value === value)) return low; // NaN
		if (value < low) return low;
		if (value > high) return high;
		return value;
	}

	function round1(value) {
		return Math.round(value * 10) / 10;
	}

	/** 数字格式化：四舍五入到指定小数位，并去掉浮点尾巴（2.9999999999 -> 3）。 */
	function fmt(value, digits) {
		if (typeof value !== "number" || !isFinite(value)) return String(value);
		var d = (digits === undefined ? 1 : digits);
		var p = Math.pow(10, d);
		var r = Math.round(value * p) / p;
		if (r === 0) return "0";
		return String(r);
	}

	function logError(where, err) {
		var t = now();
		if (t - state.lastErrorAt < 5000) return;
		state.lastErrorAt = t;
		try {
			console.error(LOG_PREFIX + " " + where + " failed; skipped this auto-advance.", err);
		} catch (_e) { /* ignore */ }
	}

	/** 用 typeof 安全地探测一个引擎符号（缺失时返回 "undefined"）。 */
	function typeOfSymbol(name) {
		try {
			// eslint-disable-next-line no-eval
			return eval("typeof " + name);
		} catch (_e) {
			return "error";
		}
	}

	function hasSymbol(name, expected) {
		var t = typeOfSymbol(name);
		if (expected === "function") return t === "function";
		return t !== "undefined" && t !== "error";
	}

	// ------------------------------------------------------------------ 设置读写

	function settingsTab() {
		try {
			if (typeof KDModSettings !== "object" || KDModSettings === null) return null;
			var tab = KDModSettings[MOD_ID];
			if (!tab || typeof tab !== "object") {
				tab = {};
				KDModSettings[MOD_ID] = tab;
			}
			return tab;
		} catch (_e) {
			return null;
		}
	}

	/**
	 * 补齐所有选项。必须做，原因有两个：
	 * - mod 文件在 KDLoadModSettings() 之前执行，而那之后 KDModSettings 会被整体替换；
	 * - vanilla 配置界面对 list 类型从不写入默认值（KDMods.ts:743/768）。
	 */
	function initDefaults() {
		var tab = settingsTab();
		if (!tab) return;
		for (var key in DEFAULTS) {
			if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) continue;
			if (OPTION_KEYS[key]) continue; // 列表型交给 syncOptionIds
			if (tab[key] === undefined) tab[key] = DEFAULTS[key];
		}
		syncOptionIds(tab);

		// 数值归一化：滑块步进会累积浮点误差（0.30000000000000004 之类），
		// 在配置页和面板里都可能显示成一大串；这里统一抹平。
		sanitizeNumbers(tab);
	}

	/**
	 * 列表型设置的显示值与稳定 id 对齐：
	 * - 存的值认得出来（当前语言显示值 / 旧版本写法）→ 以它为准，刷新 <键>Id；
	 * - 认不出来（例如刚换过游戏语言）→ 用上次记下的 id 还原同一项；
	 * - 都没有 → 默认值。
	 */
	function syncOptionIds(tab) {
		for (var key in OPTION_KEYS) {
			if (!Object.prototype.hasOwnProperty.call(OPTION_KEYS, key)) continue;
			var id = optionId(key, tab[key]);
			if (id === null) {
				var remembered = tab[key + "Id"];
				id = (OPTION_IDS[key].indexOf(remembered) >= 0) ? remembered : DEFAULTS[key];
			}
			tab[key] = optionLabel(key, id);
			tab[key + "Id"] = id;
		}
	}

	/** 读一个列表型设置：优先认当前存的值，其次认记下的 id（换过语言），最后回默认。 */
	function readOption(tab, key) {
		var id = optionId(key, tab[key]);
		if (id === null) {
			var remembered = tab[key + "Id"];
			id = (OPTION_IDS[key].indexOf(remembered) >= 0) ? remembered : DEFAULTS[key];
		}
		return id;
	}

	/** 把设置里的数值收敛到合理精度（整数毫秒 / 两位小数），避免浮点尾巴。 */
	function sanitizeNumbers(tab) {
		var ints = ["KDRLBaseInterval", "KDRLMinInterval", "KDRLMaxInterval", "KDRLInspectSlow", "KDRLAimSlow"];
		var decimals = ["KDRLLinear", "KDRLStage", "KDRLJitter"];
		var i, v;
		for (i = 0; i < ints.length; i++) {
			v = tab[ints[i]];
			if (typeof v === "number" && isFinite(v)) tab[ints[i]] = Math.round(v);
		}
		for (i = 0; i < decimals.length; i++) {
			v = tab[decimals[i]];
			if (typeof v === "number" && isFinite(v)) tab[decimals[i]] = Math.round(v * 100) / 100;
		}
	}

	function isFiniteNumber(value) {
		return typeof value === "number" && isFinite(value);
	}

	function toBool(value, fallback) {
		if (typeof value === "boolean") return value;
		if (value === "true") return true;
		if (value === "false") return false;
		return fallback;
	}

	function toNumber(value, fallback, low, high) {
		var n = (typeof value === "number" ? value : parseFloat(value));
		if (!isFinite(n)) n = fallback;
		if (low !== undefined && n < low) n = low;
		if (high !== undefined && n > high) n = high;
		return n;
	}

	/** 读取并清洗当前选项，永不抛异常。 */
	function readCfg() {
		var tab = (function () {
			try {
				return (typeof KDModSettings === "object" && KDModSettings && typeof KDModSettings[MOD_ID] === "object" && KDModSettings[MOD_ID]) || {};
			} catch (_e) {
				return {};
			}
		})();

		// 列表型：显示值随语言变，逻辑统一换算成稳定 id。
		var mode = readOption(tab, "KDRLMode");
		var polarity = readOption(tab, "KDRLPolarity");

		var minInterval = toNumber(tab.KDRLMinInterval, DEFAULTS.KDRLMinInterval, 250, 60000);
		var maxInterval = toNumber(tab.KDRLMaxInterval, DEFAULTS.KDRLMaxInterval, 250, 120000);

		// "子弹时间"倍数：0 = 暂停（等于旧版行为），1 = 正常，>1 = 这一拍的间隔乘这么多倍。
		var inspectSlow = Math.round(toNumber(tab.KDRLInspectSlow, DEFAULTS.KDRLInspectSlow, 0, 20));
		var aimSlow = Math.round(toNumber(tab.KDRLAimSlow, DEFAULTS.KDRLAimSlow, 0, 20));

		var indicator = readOption(tab, "KDRLIndicator");

		// 安静模式：quietSeconds > 0 表示"只在最后 N 秒出现"；quietStamina 表示"体力低于 25% 时出现"。
		var quiet = readOption(tab, "KDRLQuiet");
		var quietSeconds = 0;
		var quietStamina = false;
		if (quiet === "last3") quietSeconds = 3;
		else if (quiet === "last5") quietSeconds = 5;
		else if (quiet === "stamina25") quietStamina = true;
		else if (quiet === "either") { quietSeconds = 3; quietStamina = true; }

		return {
			enabled: toBool(tab.KDRLEnabled, DEFAULTS.KDRLEnabled),
			indicator: indicator,
			quietSeconds: quietSeconds,
			quietStamina: quietStamina,
			mode: mode,
			base: toNumber(tab.KDRLBaseInterval, DEFAULTS.KDRLBaseInterval, 250, 60000),
			linear: toNumber(tab.KDRLLinear, DEFAULTS.KDRLLinear, 0, 1),
			stage: toNumber(tab.KDRLStage, DEFAULTS.KDRLStage, 0, 1),
			minInterval: minInterval,
			maxInterval: maxInterval,
			inspectSlow: inspectSlow,
			aimSlow: aimSlow,
			polarity: polarity,
			jitter: toNumber(tab.KDRLJitter, DEFAULTS.KDRLJitter, 0, 0.5),
			notify: toBool(tab.KDRLNotify, DEFAULTS.KDRLNotify),
			showHud: toBool(tab.KDRLShowHud, DEFAULTS.KDRLShowHud),
			debug: toBool(tab.KDRLDebug, DEFAULTS.KDRLDebug),
			diag: toBool(tab.KDRLDiag, DEFAULTS.KDRLDiag),
		};
	}

	// ------------------------------------------------------------------ 节奏计算

	/** 当前体力比例（0..1）。读不到时返回 1（当作满体力，最慢节奏）。 */
	function staminaRatio() {
		var current = (typeof KinkyDungeonStatStamina === "number" ? KinkyDungeonStatStamina : 0);
		var max = (typeof KinkyDungeonStatStaminaMax === "number" ? KinkyDungeonStatStaminaMax : 0);
		if (!(max > 0) || !isFinite(current)) return 1;
		var ratio = current / max;
		if (!isFinite(ratio)) return 1;
		return clamp(ratio, 0, 1);
	}

	function hasStamina() {
		return typeof KinkyDungeonStatStamina === "number"
			&& typeof KinkyDungeonStatStaminaMax === "number"
			&& KinkyDungeonStatStaminaMax > 0;
	}

	function stageIndex(ratio) {
		for (var i = 0; i < STAGE_THRESHOLDS.length; i++) {
			if (ratio >= STAGE_THRESHOLDS[i]) return i;
		}
		return STAGE_FACTORS.length - 1;
	}

	/** 把体力比例映射成"这一拍该等多久"。 */
	function computeInterval(cfg) {
		var ratio = staminaRatio();
		// "低体力更快"（默认）：体力低 -> r 小 -> 间隔短。
		// "低体力更慢"：把曲线镜像过来。
		var r = cfg.polarity === "tired_slow" ? (1 - ratio) : ratio;

		var linearFactor = 1 - cfg.linear * (1 - r);
		var stagedFactor = 1 + (STAGE_FACTORS[stageIndex(r)] - 1) * cfg.stage;

		var factor;
		if (cfg.mode === "linear") factor = linearFactor;
		else if (cfg.mode === "staged") factor = stagedFactor;
		else factor = linearFactor * stagedFactor;

		var ms = cfg.base * factor;
		if (cfg.jitter > 0) {
			ms *= 1 + (Math.random() * 2 - 1) * cfg.jitter;
		}

		var low = Math.min(cfg.minInterval, cfg.maxInterval);
		var high = Math.max(cfg.minInterval, cfg.maxInterval);
		return Math.round(clamp(ms, low, high));
	}

	function currentStage(cfg) {
		var ratio = staminaRatio();
		var r = cfg.polarity === "tired_slow" ? (1 - ratio) : ratio;
		return stageIndex(r);
	}

	function currentTick() {
		return (typeof KinkyDungeonCurrentTick === "number" ? KinkyDungeonCurrentTick : null);
	}

	// ------------------------------------------------- 检视 / 瞄准的"子弹时间"

	/**
	 * 当前是否处于"该慢放而不是该暂停"的模式。
	 * 检视（自由镜头查看）优先；其次是法术 / 物品 / 武器的瞄准状态。
	 */
	function detectSlowKind() {
		if (typeof KinkyDungeonInspect !== "undefined" && KinkyDungeonInspect) return "inspect";
		if (aimingNow()) return "aim";
		return "";
	}

	/** 是否正在瞄准（法术 / 物品 / 武器）。 */
	function aimingNow() {
		if (typeof KinkyDungeonTargetingSpell !== "undefined" && KinkyDungeonTargetingSpell) return true;
		if (typeof KinkyDungeonTargetingSpellItem !== "undefined" && KinkyDungeonTargetingSpellItem) return true;
		if (typeof KinkyDungeonTargetingSpellWeapon !== "undefined" && KinkyDungeonTargetingSpellWeapon) return true;
		return false;
	}

	/** 当前模式对应的倍数：1 = 正常速度，0 = 暂停（由 canAdvance 处理成旧行为），>1 = 慢放。 */
	function slowMultiplier(cfg) {
		if (state.slowKind !== "inspect" && state.slowKind !== "aim") return 1;
		var raw = (state.slowKind === "inspect" ? cfg.inspectSlow : cfg.aimSlow);
		// 读不到就退回 1（正常速度），绝不因为缺字段意外变成"暂停"。
		var n = (typeof raw === "number" && isFinite(raw)) ? raw : 1;
		return clamp(Math.round(n), 0, 20);
	}

	/** 基准间隔 × 倍数，并压在安全上限里。 */
	function effectiveInterval(base, mult) {
		var m = (isFiniteNumber(mult) && mult > 0) ? mult : 1;
		return Math.round(clamp(base * m, 1, SLOW_CAP_MS));
	}

	/**
	 * 模式切换时平滑换挡：保留"这一拍已经走过去几成"，只把剩余时间按新旧倍数换算。
	 * 效果就是时间被拉长 / 松开，指示器的进度不会跳一下。
	 */
	function syncSlowInterval(cfg, t) {
		var mult = slowMultiplier(cfg);
		if (!(state.baseInterval > 0)) state.baseInterval = computeInterval(cfg);
		var eff = effectiveInterval(state.baseInterval, mult);
		if (mult !== state.mult && state.interval > 0) {
			var p = clamp((t - state.lastAdvance) / state.interval, 0, 1);
			state.lastAdvance = t - p * eff;
		}
		state.mult = mult;
		state.interval = eff;
	}

	/** 软暂停模式的名称（面板 / 日志用）。 */
	function slowName() {
		if (state.slowKind === "inspect") return say("KDRLSlowInspect");
		if (state.slowKind === "aim") return say("KDRLSlowAim");
		return "";
	}

	// ------------------------------------------------------------------ 安全闸门

	function block(reason, detail) {
		state.reason = reason;
		state.reasonDetail = detail || "";
		return false;
	}

	/** 取当前玩家实体。正常情况就是全局 KinkyDungeonPlayerEntity；若将来变成函数也兼容。 */
	function playerEntity() {
		var p = null;
		try {
			if (typeof KinkyDungeonPlayerEntity !== "undefined") p = KinkyDungeonPlayerEntity;
			if (typeof p === "function") p = p();
		} catch (_e) { p = null; }
		if (!p) {
			try {
				if (typeof KDPlayer === "function") p = KDPlayer();
			} catch (_e2) { p = null; }
		}
		return p || null;
	}

	/**
	 * 只有完全"空闲且安全"时才允许替玩家消耗一回合。
	 * 每个不满足的条件都会写进 state.reason，面板会直接显示出来。
	 */
	function canAdvance() {
		state.reasonDetail = "";
		state.slowKind = "";

		if (typeof KinkyDungeonState === "undefined" || KinkyDungeonState !== "Game") {
			return block("notgame", typeof KinkyDungeonState !== "undefined" ? String(KinkyDungeonState) : "");
		}
		if (typeof KinkyDungeonDrawState !== "undefined" && KinkyDungeonDrawState !== "Game") {
			return block("subscreen", String(KinkyDungeonDrawState));
		}

		if (typeof KDGameData === "undefined" || !KDGameData) return block("nodata", "KDGameData");
		if (typeof KDMapData === "undefined" || !KDMapData) return block("nodata", "KDMapData");
		if (typeof KDMapData.GridWidth !== "number" || KDMapData.GridWidth <= 0) return block("nodata", say("KDRLDetailMapSize"));

		// 玩家实体：注意玩家的 entity.id 恒为 -1（5.5.6 / 5.5.12 都一样，见 5.5.12
		// KinkyDungeonGame.ts:3571 `if (!KinkyDungeonPlayerEntity.id) ... = -1`），
		// 所以"id >= 0"不能当作"玩家已生成"的判据 —— 只要坐标是有效数字即可。
		var playerAt = playerEntity();
		if (!playerAt) return block("nodata", say("KDRLDetailPlayerEntity"));
		if (!(typeof playerAt.x === "number" && isFinite(playerAt.x)
			&& typeof playerAt.y === "number" && isFinite(playerAt.y))) {
			return block("nodata", say("KDRLDetailPlayerCoords", { pos: fmt(playerAt.x, 2) + "," + fmt(playerAt.y, 2) }));
		}

		// 菜单 / 弹窗 / 覆盖层
		// 不用 KinkyDungeonControlsEnabled()：它读 KDGameData 的多个字段，旧存档缺字段时会永远为假；
		// 这里逐项显式判断（Inspect / SlowMoveTurns / Freeze / SleepTurns / CurrentDialog / MessageToggle），对缺字段免疫。
		if (typeof KinkyDungeonMessageToggle !== "undefined" && KinkyDungeonMessageToggle) return block("controls", say("KDRLDetailMessageOverlay"));
		if (typeof KDModalArea !== "undefined" && KDModalArea) return block("modal", "KDModalArea");
		if (typeof KDContextMenu !== "undefined" && KDContextMenu) return block("modal", "KDContextMenu");
		// 快速物品栏（KD 的快捷背包覆盖层）默认也当菜单处理；但如果此时正在瞄准
		// （法术 / 物品 / 武器），玩家其实是在"选目标"，按瞄准的慢放处理更有意义。
		if (!aimingNow()
			&& typeof KinkyDungeonShowInventory !== "undefined" && KinkyDungeonShowInventory) {
			return block("inventory", say("KDRLDetailInventory"));
		}
		// 检视 / 施法瞄准 不在这里拦：它们由下面的"子弹时间"慢放处理（倍数 0 时才暂停）。
		if (KDGameData.CurrentDialog) return block("dialog");
		if (KDGameData.ConfirmAttack) return block("dialog", say("KDRLDetailAttackConfirm"));
		if (KDGameData.InventoryAction) return block("inventory", String(KDGameData.InventoryAction));
		if (KDGameData.InventoryActionContainer && KDGameData.InventoryActionContainer.length > 0) return block("inventory", say("KDRLDetailContainer"));
		if (typeof KDSaveBusy !== "undefined" && KDSaveBusy) return block("save");

		// 别的自动模式正在接管回合时钟：绝不重复推进
		if (typeof KinkyDungeonAutoWait !== "undefined" && KinkyDungeonAutoWait) return block("autowait", say("KDRLDetailAutoWait"));
		if (typeof KinkyDungeonAutoWaitStruggle !== "undefined" && KinkyDungeonAutoWaitStruggle) return block("autowait", say("KDRLDetailAutoStruggle"));
		if (typeof KDAutoWaitDelayed !== "undefined" && KDAutoWaitDelayed) return block("autowait", say("KDRLDetailDelayedAutoWait"));
		if (typeof KinkyDungeonFastMovePath !== "undefined" && KinkyDungeonFastMovePath && KinkyDungeonFastMovePath.length > 0) return block("autowait", say("KDRLDetailFastMove"));
		if (typeof KinkyDungeonFastStruggle !== "undefined" && KinkyDungeonFastStruggle) return block("autowait", say("KDRLDetailFastStruggle"));
		if (typeof KinkyDungeonFastStruggleType !== "undefined" && KinkyDungeonFastStruggleType) return block("autowait", say("KDRLDetailFastStruggle"));
		if (typeof KinkyDungeonFastStruggleGroup !== "undefined" && KinkyDungeonFastStruggleGroup) return block("autowait", say("KDRLDetailFastStruggle"));

		// 引擎自己管理的回合
		if (KDGameData.SleepTurns > 0 || KDGameData.PlaySelfTurns > 0) return block("sleep");
		if (typeof KinkyDungeonStatFreeze !== "undefined" && KinkyDungeonStatFreeze > 0) return block("freeze");
		if (KDGameData.SlowMoveTurns > 0) return block("slow");
		if (KDGameData.DelayedActions && KDGameData.DelayedActions.length > 0) return block("delayed");

		if (typeof KinkyDungeonInputQueue !== "undefined" && KinkyDungeonInputQueue && KinkyDungeonInputQueue.length > 0) return block("input");

		// 站在楼梯上：连续两次等待会被引擎判定为确认下楼（KinkyDungeonTiles.ts:109-127，每次 AdvanceTime 都会检查）
		if (typeof KinkyDungeonConfirmStairs !== "undefined" && KinkyDungeonConfirmStairs) return block("stairs", say("KDRLDetailStairsConfirm"));
		var here = null;
		if (typeof KinkyDungeonMapGet === "function") {
			try { here = KinkyDungeonMapGet(playerAt.x, playerAt.y); } catch (_e) { here = null; }
		}
		if (typeof KinkyDungeonStairTiles === "string" && here !== null && KinkyDungeonStairTiles.indexOf(here) >= 0) {
			return block("stairs", String(here));
		}

		// 站在"零方向 move 会变成点击/绘制交互"的对象格上：那种情况下输入不会消耗回合
		// （KinkyDungeonGame.ts:3042-3054 只认 KDObjectDraw / KDObjectClick；KDObjectInteract 是显式交互键才用）。
		if (here !== null && typeof KinkyDungeonTilesGet === "function") {
			var hereTile = null;
			try {
				hereTile = KinkyDungeonTilesGet(playerAt.x + "," + playerAt.y);
			} catch (_e) { hereTile = null; }
			if (hereTile && hereTile.Type) {
				var objType = hereTile.Type;
				var hasDraw = typeof KDObjectDraw === "object" && KDObjectDraw && KDObjectDraw[objType];
				var hasClick = typeof KDObjectClick === "object" && KDObjectClick && KDObjectClick[objType];
				if (hasDraw || hasClick) return block("object", String(objType));
			}
		}

		// 检视 / 施法瞄准：改成"子弹时间"——时间继续走，只是这一拍的间隔乘上倍数。
		// 倍数设成 0 等于让玩家恢复旧版的"暂停"，这时照旧冻结时钟。
		state.slowKind = detectSlowKind();
		if (state.slowKind) {
			var cfg = readCfg();
			if (!(slowMultiplier(cfg) > 0)) {
				return block(state.slowKind === "inspect" ? "inspectPause" : "aimPause");
			}
		}

		state.reason = "countdown";
		state.reasonDetail = "";
		return true;
	}

	// ------------------------------------------------------------------ 消耗回合

	/** 用与 vanilla 自动等待完全相同的零方向输入消耗一回合。 */
	function advanceTurn() {
		var data = {
			dir: { x: 0, y: 0, delta: 0 },
			delta: 1,
			AllowInteract: true,
			AutoDoor: false,
			AutoPass: (typeof KinkyDungeonToggleAutoPass !== "undefined" ? KinkyDungeonToggleAutoPass : true),
			sprint: (typeof KinkyDungeonToggleAutoSprint !== "undefined" ? KinkyDungeonToggleAutoSprint : false),
			SuppressSprint: (typeof KinkyDungeonSuppressSprint !== "undefined" ? KinkyDungeonSuppressSprint : true),
		};

		state.suppressWaitMsg = true;
		try {
			KDSendInput("move", data, false, true);
		} finally {
			state.suppressWaitMsg = false;
		}
		return true;
	}

	function announce(text, color) {
		try {
			if (typeof KinkyDungeonState !== "undefined" && KinkyDungeonState !== "Game") return;
			if (typeof KinkyDungeonSendActionMessage === "function") {
				KinkyDungeonSendActionMessage(2, text, color, 3);
			}
		} catch (_e) { /* 纯装饰，失败无所谓 */ }
	}

	function notifyStage(cfg, index) {
		if (!cfg.notify) return;
		try {
			if (typeof TextGet === "function") announce(TextGet(STAGE_KEYS[index]), STAGE_COLORS[index]);
		} catch (err) {
			logError("notifyStage", err);
		}
	}

	function resetTimers() {
		state.active = false;
		state.lastAdvance = now();
		state.interval = 0;
		state.baseInterval = 0;
		state.mult = 1;
		state.slowKind = "";
		state.mapRef = (typeof KDMapData !== "undefined" ? KDMapData : null);
		state.stage = currentStage(readCfg());
		state.noticePending = true;
		state.lastTick = currentTick();
	}

	// ------------------------------------------------------------------ 主 tick

	function tick() {
		if (state.inTick) return;
		state.inTick = true;
		try {
			tickInner();
		} catch (err) {
			state.reason = "error";
			logError("tick", err);
		} finally {
			state.inTick = false;
			var cfg = readCfg();
			try {
				renderHud(cfg);
			} catch (err) {
				logError("renderHud", err);
			}
			try {
				drawWorldIndicator(cfg);
			} catch (err2) {
				logError("indicator", err2);
			}
			// 诊断快照独立于大面板：日常模式下也能随时从 localStorage 取到状态
			if (cfg.diag) {
				try { writeSnapshot(); } catch (_e) { /* ignore */ }
			}
		}
	}

	function tickInner() {
		var cfg = readCfg();
		var t = now();

		if (!cfg.enabled) {
			state.active = false;
			state.interval = 0;
			state.lastAdvance = t;
			block("disabled");
			return;
		}

		if (!state.ready) {
			block("error", say("KDRLDetailMissingEngineFn", { name: "KDSendInput" }));
			return;
		}

		// 新的一局 / 新楼层：从零开始计时，避免进图瞬间就推进
		if (typeof KDMapData !== "undefined" && KDMapData && state.mapRef !== KDMapData) {
			resetTimers();
		}

		if (!canAdvance()) {
			state.active = false;
			state.interval = 0;
			state.lastAdvance = t;
			state.lastTick = currentTick();
			logReasonChange();
			return;
		}

		// 空闲计时：自上次观察以来只要回合数变过（玩家或引擎消耗了回合），就重新计时。
		// 同时避免玩家刚按键的那一帧又被我们补一回合。
		var tickNow = currentTick();
		if (state.lastTick === null) {
			state.lastTick = tickNow;
		} else if (tickNow !== null && tickNow !== state.lastTick) {
			state.lastTick = tickNow;
			state.active = false;
			state.lastAdvance = t;
			state.interval = 0;
			block("idle");
			logReasonChange();
			return;
		}

		// 阶段播报（体力变化时）
		var stage = currentStage(cfg);
		if (stage !== state.stage) {
			var firstStage = state.stage < 0;
			state.stage = stage;
			if (!firstStage) notifyStage(cfg, stage);
		}

		if (!state.active) {
			state.active = true;
			state.lastAdvance = t;
			state.baseInterval = computeInterval(cfg);
			state.mult = slowMultiplier(cfg);
			state.interval = effectiveInterval(state.baseInterval, state.mult);
			block("countdown");
			logReasonChange();
			return;
		}

		// 进出检视 / 施法瞄准时平滑换挡：时间被"拉长/松开"，指示器进度不跳变。
		syncSlowInterval(cfg, t);

		if (!(state.interval > 0)) {
			state.baseInterval = computeInterval(cfg);
			state.interval = effectiveInterval(state.baseInterval, state.mult);
			block("countdown");
			return;
		}

		if (t - state.lastAdvance < state.interval) {
			block("countdown");
			return;
		}

		// 到点了：替玩家消耗一回合
		var tickBefore = currentTick();
		state.attempts += 1;
		try {
			advanceTurn();
		} catch (err) {
			logError("advanceTurn", err);
			state.reason = "error";
			state.lastAdvance = t;
			state.baseInterval = computeInterval(cfg);
			state.mult = slowMultiplier(cfg);
			state.interval = effectiveInterval(state.baseInterval, state.mult);
			return;
		}

		state.lastAdvance = now();
		state.baseInterval = computeInterval(cfg);
		state.mult = slowMultiplier(cfg);
		state.interval = effectiveInterval(state.baseInterval, state.mult);
		var tickAfter = currentTick();
		state.lastTick = tickAfter;

		// 回合数没动：说明这次零方向输入被物体/界面吞掉了，安静地等下一拍。
		if (tickBefore !== null && tickAfter !== null && tickAfter === tickBefore) {
			state.lastAttemptFailed = true;
			block("nomove");
			if (cfg.debug) {
				console.warn(LOG_PREFIX + " wait #" + state.attempts + " spent no turn (input swallowed), retrying next tick.");
			}
			logReasonChange();
			return;
		}

		state.lastAttemptFailed = false;
		state.advanceCount += 1;
		state.lastAdvanceAt = now();
		block("countdown");

		if (cfg.debug || state.advanceCount <= 5) {
			try {
				console.log(LOG_PREFIX + " auto-advanced turn " + state.advanceCount
					+ " (interval " + state.interval + "ms"
					+ (state.mult > 1 ? ", slow x" + fmt(state.mult, 0) : "")
					+ ", stamina "
					+ (hasStamina() ? fmt(KinkyDungeonStatStamina) + "/" + fmt(KinkyDungeonStatStaminaMax)
						+ ", " + Math.round(staminaRatio() * 100) + "%" : "unreadable")
					+ ", stage " + (state.stage + 1) + "/" + STAGE_NAME_KEYS.length + ")");
			} catch (_e) { /* ignore */ }
		}

		if (state.noticePending) {
			state.noticePending = false;
			if (cfg.notify && typeof TextGet === "function") announce(TextGet("KDRLStartNotice"), "#cfcfcf");
		}
	}

	/** 暂停原因变化时写一条控制台日志（只在开启调试时，且只记"值得注意"的原因）。 */
	function logReasonChange() {
		var reason = state.reason;
		if (reason === state.lastLoggedReason) return;
		state.lastLoggedReason = reason;
		if (reason === "countdown" || reason === "idle" || reason === "init") return;
		var cfg;
		try { cfg = readCfg(); } catch (_e) { cfg = { debug: false }; }
		if (!cfg.debug) return;
		try {
			console.log(LOG_PREFIX + " paused: " + reason
				+ (state.reasonDetail ? " (" + state.reasonDetail + ")" : ""));
		} catch (_e) { /* ignore */ }
	}

	// ---------------------------------------------------------- 世界内指示器
	// 用引擎自己的图元 API 在玩家周围画一个克制的小提示：
	// - 环形（脚下）：一圈细弧，随倒计时顺时针填满；
	// - 进度条（头顶）：头顶一条细进度条。
	// 颜色跟着体力阶段走（冷蓝 → 绿 → 琥珀 → 橙 → 红），所以不用看数字也能感知"时间在变急"。
	// 暂停（菜单/对话/楼梯等）时直接不画，保持画面干净。

	var INDICATOR_IDS = ["kdauRingBg", "kdauRingFg", "kdauFootBarBg", "kdauFootBarFg", "kdauBarBg", "kdauBarFg"];

	/** 每种样式只保留自己那几个图元，其余一律隐藏。 */
	function hideIndicatorExcept(keep) {
		var i, id;
		for (i = 0; i < INDICATOR_IDS.length; i++) {
			id = INDICATOR_IDS[i];
			if (id.indexOf(keep) !== 0) hideIndicatorId(id);
		}
	}

	function indicatorAvailable() {
		return typeof kdpixisprites !== "undefined" && kdpixisprites
			&& typeof kdstatusboard !== "undefined" && kdstatusboard
			&& typeof kdstatusboardunder !== "undefined" && kdstatusboardunder
			&& typeof FillCircleBarKD === "function"
			&& typeof DrawCircleKD === "function"
			&& typeof FillRectKD === "function";
	}

	function hideIndicatorId(id) {
		try {
			var sp = kdpixisprites.get(id);
			if (sp) sp.visible = false;
		} catch (_e) { /* ignore */ }
	}

	function hideIndicator() {
		for (var i = 0; i < INDICATOR_IDS.length; i++) hideIndicatorId(INDICATOR_IDS[i]);
	}

	/** 玩家所在格的屏幕坐标（设计分辨率 2000x1000 下），与引擎画玩家精灵用的是同一套换算。 */
	function playerScreenAnchor(player, gs) {
		var camX = (typeof KinkyDungeonCamXVis === "number" ? KinkyDungeonCamXVis
			: (typeof KinkyDungeonCamX === "number" ? KinkyDungeonCamX : 0));
		var camY = (typeof KinkyDungeonCamYVis === "number" ? KinkyDungeonCamYVis
			: (typeof KinkyDungeonCamY === "number" ? KinkyDungeonCamY : 0));
		var vx = (typeof player.visual_x === "number" ? player.visual_x : player.x);
		var vy = (typeof player.visual_y === "number" ? player.visual_y : player.y);
		return { x: (vx - camX) * gs, y: (vy - camY) * gs };
	}

	/** 脚下环形时钟。 */
	function drawFootRing(sx, sy, progress, color, gs, alpha) {
		var cx = sx + gs * 0.5;
		var cy = sy + gs * 0.82;
		var r = gs * 0.38;
		var lw = Math.max(2.5, Math.min(5, gs * 0.045));

		// 暗色底环（位置/半径不变时引擎会复用同一个图元，不重复创建）
		DrawCircleKD(kdstatusboardunder, kdpixisprites, "kdauRingBg", {
			Left: cx - r, Top: cy - r, Width: r * 2, Height: r * 2,
			LineWidth: lw, Color: "#05050a", alpha: 0.5, zIndex: 1,
		});
		// 进度弧：从正上方顺时针填满（刚开始时太短，索性不画，避免一个点挂在角色脚下）
		if (progress > 0.015) {
			FillCircleBarKD(kdstatusboardunder, kdpixisprites, "kdauRingFg", {
				Left: cx, Top: cy, Radius: r,
				StartAngle: 0, EndingAngle: Math.PI * 2 * progress,
				Rotation: -Math.PI / 2, CounterClockwise: false,
				LineWidth: lw, Color: color, alpha: alpha, zIndex: 1.1,
			});
		} else {
			hideIndicatorId("kdauRingFg");
		}

		hideIndicatorExcept("kdauRing");
	}

	/** 脚下横条：贴在脚底，避开头顶已经有的各种条。 */
	function drawFootBar(sx, sy, progress, color, gs, alpha) {
		var w = gs * 0.7;
		var h = Math.max(3, gs * 0.075);
		var x = sx + (gs - w) / 2;
		var y = sy + gs * 0.9;

		FillRectKD(kdstatusboardunder, kdpixisprites, "kdauFootBarBg", {
			Left: x - 1.5, Top: y - 1.5, Width: w + 3, Height: h + 3,
			Color: "#05050a", alpha: 0.5, zIndex: 1,
		});
		FillRectKD(kdstatusboardunder, kdpixisprites, "kdauFootBarFg", {
			Left: x, Top: y, Width: Math.max(0.001, w * progress), Height: h,
			Color: color, alpha: alpha, zIndex: 1.1,
		});

		hideIndicatorExcept("kdauFootBar");
	}

	/** 头顶横条（原有样式，保留给需要在头上看的场合）。 */
	function drawHeadBar(sx, sy, progress, color, gs, alpha) {
		var w = gs * 0.78;
		var h = Math.max(3, gs * 0.08);
		var x = sx + (gs - w) / 2;
		var y = sy - gs * 0.2;

		FillRectKD(kdstatusboard, kdpixisprites, "kdauBarBg", {
			Left: x - 1.5, Top: y - 1.5, Width: w + 3, Height: h + 3,
			Color: "#05050a", alpha: 0.55, zIndex: 1,
		});
		FillRectKD(kdstatusboard, kdpixisprites, "kdauBarFg", {
			Left: x, Top: y, Width: Math.max(0.001, w * progress), Height: h,
			Color: color, alpha: alpha, zIndex: 1.1,
		});

		hideIndicatorExcept("kdauBar");
	}

	/** 每帧在玩家周围画指示器；不满足条件时隐藏。 */
	function drawWorldIndicator(cfg) {
		if (!cfg.enabled || cfg.indicator === "off") { hideIndicator(); return; }
		if (typeof KinkyDungeonState === "undefined" || KinkyDungeonState !== "Game") { hideIndicator(); return; }
		if (state.reason !== "countdown" || !state.active || !(state.interval > 0)) { hideIndicator(); return; }
		if (!indicatorAvailable()) { hideIndicator(); return; }

		var player = playerEntity();
		if (!player) { hideIndicator(); return; }

		var gs = (typeof KinkyDungeonGridSizeDisplay === "number" && KinkyDungeonGridSizeDisplay > 0
			? KinkyDungeonGridSizeDisplay : 72);
		var anchor = playerScreenAnchor(player, gs);
		var w = (typeof PIXIWidth === "number" ? PIXIWidth : 2000);
		var h = (typeof PIXIHeight === "number" ? PIXIHeight : 1000);
		if (anchor.x < -gs || anchor.y < -gs || anchor.x > w + gs || anchor.y > h + gs) {
			hideIndicator();
			return;
		}

		var progress = clamp((now() - state.lastAdvance) / state.interval, 0, 1);
		var stage = currentStage(cfg);
		var color = INDICATOR_COLORS[stage] || INDICATOR_COLORS[0];
		// 快到点时轻微呼吸，提醒"这一下马上要来了"
		var alpha = progress > 0.9
			? (0.7 + 0.3 * ((Math.sin(now() / 110) + 1) / 2))
			: 0.95;

		// 安静模式：平时完全不画，只在"快推进了"或"体力见底"时淡入
		if (cfg.quietSeconds > 0 || cfg.quietStamina) {
			var remainMs = state.interval - (now() - state.lastAdvance);
			var quietShow = false;
			if (cfg.quietSeconds > 0 && remainMs <= cfg.quietSeconds * 1000) quietShow = true;
			if (cfg.quietStamina && staminaRatio() < 0.25) quietShow = true;
			if (!quietShow) { hideIndicator(); return; }
			// 浮现时从半透明渐到不透明，减少突兀感
			alpha *= clamp(0.45 + 0.55 * progress, 0.45, 1);
		}

		if (cfg.indicator === "bar") drawHeadBar(anchor.x, anchor.y, progress, color, gs, alpha);
		else if (cfg.indicator === "footbar") drawFootBar(anchor.x, anchor.y, progress, color, gs, alpha);
		else drawFootRing(anchor.x, anchor.y, progress, color, gs, alpha);
	}

	// ------------------------------------------------------------------ 状态面板

	function hudNode(tag, style) {
		var el = document.createElement(tag);
		if (style) el.style.cssText = style;
		return el;
	}

	function ensureHud() {
		try {
			if (state.hudEl && state.hudEl.parentNode) return state.hudEl;
			if (typeof document === "undefined" || !document.body) return null;
			var el = document.getElementById("kdau-hud");
			if (!el) {
				el = document.createElement("div");
				el.id = "kdau-hud";
				el.style.cssText = [
					"position:fixed",
					"left:10px",
					"bottom:10px",
					"z-index:2147483000",
					"pointer-events:none",
					"font:12px/1.45 Consolas,'Courier New',monospace",
					"color:#e9e9ee",
					"background:rgba(10,10,16,.74)",
					"border:1px solid rgba(255,255,255,.22)",
					"border-radius:8px",
					"padding:7px 9px 8px 9px",
					"min-width:270px",
					"white-space:pre",
					"text-shadow:0 1px 2px #000",
					"box-shadow:0 2px 14px rgba(0,0,0,.55)",
					"display:none",
				].join(";");
				document.body.appendChild(el);
			}

			var nodes = {
				title: hudNode("div", "font-weight:bold;letter-spacing:.4px;margin-bottom:2px;"),
				l1: hudNode("div", ""),
				l2: hudNode("div", ""),
				l3: hudNode("div", ""),
				barWrap: hudNode("div", "height:5px;margin:3px 0 3px 0;background:rgba(255,255,255,.16);border-radius:3px;overflow:hidden;"),
				barFill: hudNode("div", "height:5px;width:0%;background:#7ec96f;border-radius:3px;"),
				l4: hudNode("div", ""),
				l5: hudNode("div", ""),
				pause: hudNode("div", "margin-top:2px;color:#ffb454;"),
				l6: hudNode("div", "margin-top:3px;padding-top:3px;border-top:1px solid rgba(255,255,255,.14);color:#8f9aa6;"),
				l7: hudNode("div", "color:#8f9aa6;"),
			};
			nodes.barWrap.appendChild(nodes.barFill);
			el.innerHTML = "";
			el.appendChild(nodes.title);
			el.appendChild(nodes.l1);
			el.appendChild(nodes.l2);
			el.appendChild(nodes.l3);
			el.appendChild(nodes.barWrap);
			el.appendChild(nodes.l4);
			el.appendChild(nodes.l5);
			el.appendChild(nodes.pause);
			el.appendChild(nodes.l6);
			el.appendChild(nodes.l7);

			state.hudEl = el;
			state.hudNodes = nodes;
			return el;
		} catch (_e) {
			return null;
		}
	}

	function hideHud() {
		try {
			if (state.hudEl) state.hudEl.style.display = "none";
		} catch (_e) { /* ignore */ }
	}

	function setNode(node, text, color) {
		if (!node) return;
		node.textContent = text;
		if (color) node.style.color = color;
	}

	/**
	 * 引擎原始状态快照：面板的"详细诊断"两行用它，同时写进 localStorage 方便复制给作者。
	 * 注意：这里全部用 typeof/可选链式的防御写法，任何一项缺失都不会抛错。
	 */
	function engineSnapshot() {
		var pe = playerEntity();
		var snap = {
			mod: MOD_ID,
			version: VERSION,
			state: (typeof KinkyDungeonState !== "undefined" ? String(KinkyDungeonState) : "?"),
			drawState: (typeof KinkyDungeonDrawState !== "undefined" ? String(KinkyDungeonDrawState) : "?"),
			map: (typeof KDMapData !== "undefined" && KDMapData
				? (KDMapData.GridWidth + "x" + KDMapData.GridHeight) : "none"),
			player: pe ? (fmt(pe.x, 0) + "," + fmt(pe.y, 0) + " id=" + fmt(pe.id, 0) + "(" + (typeof pe.id) + ")") : "none",
			tick: (currentTick() === null ? null : fmt(currentTick(), 2)),
			stamina: hasStamina()
				? (fmt(KinkyDungeonStatStamina) + "/" + fmt(KinkyDungeonStatStaminaMax)) : "?",
			reason: state.reason,
			reasonText: reasonText(state.reason),
			reasonDetail: state.reasonDetail,
			interval: state.interval,
			baseInterval: state.baseInterval,
			slowKind: state.slowKind,
			slowMult: state.mult,
			driver: state.driver,
			frameHookOk: state.frameHookOk,
			advanceCount: state.advanceCount,
			attempts: state.attempts,
			flags: {
				confirmStairs: (typeof KinkyDungeonConfirmStairs !== "undefined" ? !!KinkyDungeonConfirmStairs : null),
				inputQueue: (typeof KinkyDungeonInputQueue !== "undefined" && KinkyDungeonInputQueue ? KinkyDungeonInputQueue.length : null),
				autoWait: (typeof KinkyDungeonAutoWait !== "undefined" ? !!KinkyDungeonAutoWait : null),
				freeze: (typeof KinkyDungeonStatFreeze !== "undefined" ? KinkyDungeonStatFreeze : null),
				sleepTurns: (typeof KDGameData !== "undefined" && KDGameData ? KDGameData.SleepTurns : null),
				saveBusy: (typeof KDSaveBusy !== "undefined" ? !!KDSaveBusy : null),
			},
			at: (function () {
				try { return new Date(now()).toISOString(); } catch (_e) { return String(now()); }
			})(),
		};
		return snap;
	}

	function diagLines() {
		var s = engineSnapshot();
		return [
			say("KDRLPanelEngineLine", { state: s.state + "/" + s.drawState, map: s.map, turn: s.tick, stamina: s.stamina }),
			say("KDRLPanelPlayerLine", { player: s.player, queue: s.flags.inputQueue, autoWait: s.flags.autoWait }),
		];
	}

	/** 每 2 秒把快照写进 localStorage，控制台上下文不对时也能从 Application 面板复制。 */
	function writeSnapshot() {
		var t = now();
		if (state.lastSnapshotAt && t >= state.lastSnapshotAt && (t - state.lastSnapshotAt) < 2000) return;
		state.lastSnapshotAt = t;
		try {
			window.localStorage.setItem("KDRestlessDiag", JSON.stringify(engineSnapshot()));
		} catch (_e) { /* 隐私模式等，忽略 */ }
	}

	function hudModel(cfg) {
		var t = now();
		var inGame = (typeof KinkyDungeonState !== "undefined" && KinkyDungeonState === "Game");
		var stateName = (typeof KinkyDungeonState !== "undefined" ? String(KinkyDungeonState) : say("KDRLPanelStateUnknown"));

		var driverText = say("KDRLPanelStateUnknown");
		if (state.driver === "none") driverText = say("KDRLPanelDriverNone");
		else if (!inGame) driverText = say("KDRLPanelDriverNotGame");
		else if (state.frameHookOk && state.lastFrameAt === 0) driverText = say("KDRLPanelDriverWaiting");
		else if (state.frameHookOk && (t - state.lastFrameAt) < 400) driverText = say("KDRLPanelDriverFrame");
		else if (state.timer) driverText = say("KDRLPanelDriverTimer");
		else driverText = say("KDRLPanelDriverFrameDead");

		var ratio = staminaRatio();
		var staminaText = hasStamina()
			? say("KDRLPanelStaminaValue", {
				cur: fmt(KinkyDungeonStatStamina),
				max: fmt(KinkyDungeonStatStaminaMax),
				pct: Math.round(ratio * 100),
			})
			: say("KDRLPanelStaminaUnreadable");

		var stage = currentStage(cfg);
		var elapsed = Math.max(0, t - state.lastAdvance);
		var progress = (state.active && state.interval > 0) ? clamp(elapsed / state.interval, 0, 1) : 0;

		var lastAdvanceText = state.lastAdvanceAt
			? say("KDRLPanelAgo", { sec: fmt((t - state.lastAdvanceAt) / 1000) })
			: say("KDRLPanelNever");

		var pauseText = "";
		if (state.reason !== "countdown") {
			pauseText = say("KDRLPanelPause", {
				text: reasonText(state.reason)
					+ (state.reasonDetail ? say("KDRLPanelDetail", { text: state.reasonDetail }) : ""),
			});
		}
		if (state.lastAttemptFailed) {
			pauseText = (pauseText ? pauseText + "  ·  " : "") + say("KDRLPanelRetry");
		}

		// "子弹时间"：检视 / 瞄准期间时间还在走，只是变慢——面板单独标出来。
		var slowText = "";
		if (state.reason === "countdown" && state.slowKind && state.mult > 0) {
			slowText = say("KDRLPanelSlowLine", {
				name: slowName(),
				mult: fmt(state.mult, 0),
				base: fmt(state.baseInterval, 0),
				now: fmt(state.interval, 0),
			});
		}

		var ok = (state.reason === "countdown" || state.reason === "idle") && cfg.enabled;
		var titleColor = "#7ec96f";
		if (!cfg.enabled) titleColor = "#9a9aa0";
		else if (!ok) titleColor = "#ffb454";
		if (state.reason === "error") titleColor = "#ff6b6b";

		return {
			inGame: inGame,
			stateName: stateName,
			driverText: driverText,
			staminaText: staminaText,
			stageName: hasStamina() ? stageName(stage) : say("KDRLStageNameNone"),
			stageColor: STAGE_COLORS[stage],
			modeText: optionLabel("KDRLMode", cfg.mode),
			polarityText: optionLabel("KDRLPolarity", cfg.polarity),
			intervalText: (state.interval > 0 ? state.interval : computeInterval(cfg)) + " ms",
			progress: progress,
			countdownText: (state.active && state.interval > 0)
				? say("KDRLPanelCountdownValue", { elapsed: fmt(elapsed / 1000, 1), total: fmt(state.interval / 1000, 1) })
				: "—",
			advanceCount: state.advanceCount,
			attempts: state.attempts,
			lastAdvanceText: lastAdvanceText,
			pauseText: pauseText,
			slowText: slowText,
			running: ok,
			titleColor: titleColor,
		};
	}

	function renderHud(cfgIn) {
		var cfg;
		try { cfg = cfgIn || readCfg(); } catch (_e) { return; }
		if (!cfg.showHud) {
			hideHud();
			return;
		}
		var el = ensureHud();
		if (!el || !state.hudNodes) return;

		var t = now();
		// 每 100ms 左右刷新一次就够；同时容忍时钟回退（例如测试里的假时钟被重置）。
		if (t >= state.lastHudAt && (t - state.lastHudAt) < 90) {
			el.style.display = "block";
			return;
		}
		state.lastHudAt = t;

		var n = state.hudNodes;
		var m = hudModel(cfg);
		el.style.display = "block";
		var compact = !m.inGame;

		setNode(n.title, say("KDRLPanelTitle", { ver: VERSION }) + "  "
			+ (cfg.enabled ? (m.running ? say("KDRLPanelRunning") : say("KDRLPanelPaused")) : say("KDRLPanelOff")), m.titleColor);
		setNode(n.l1, compact
			? say("KDRLPanelLoadedScreen", { screen: m.stateName })
			: say("KDRLPanelScreenLine", { driver: m.driverText }), "#c9c9d1");

		n.l2.style.display = compact ? "none" : "block";
		n.l3.style.display = compact ? "none" : "block";
		n.barWrap.style.display = compact ? "none" : "block";
		n.l5.style.display = compact ? "none" : "block";
		n.l4.style.display = "block";

		if (compact) {
			setNode(n.l4, say("KDRLPanelCompactNote"), "#9aa3ad");
			n.pause.style.display = "none";
			n.pause.textContent = "";
			n.l6.style.display = "none";
			n.l7.style.display = "none";
			return;
		}

		setNode(n.l2, say("KDRLPanelStaminaLine", { value: m.staminaText, stage: m.stageName }), "#c9c9d1");
		setNode(n.l3, say("KDRLPanelIntervalLine", { interval: m.intervalText, mode: m.modeText, polarity: m.polarityText }), "#c9c9d1");
		n.barFill.style.width = Math.round(m.progress * 100) + "%";
		n.barFill.style.background = m.running ? "#7ec96f" : "#ffb454";
		setNode(n.l4, say("KDRLPanelCountdownLine", { value: m.countdownText }), "#c9c9d1");
		setNode(n.l5, say("KDRLPanelAdvances", { count: m.advanceCount, attempts: m.attempts, ago: m.lastAdvanceText }), "#c9c9d1");
		if (m.pauseText) {
			n.pause.style.display = "block";
			n.pause.style.color = "#ffb454";
			n.pause.textContent = m.pauseText;
		} else if (m.slowText) {
			// "子弹时间"状态：时间在走，只是慢，所以用冷色而不是暂停的橙色。
			n.pause.style.display = "block";
			n.pause.style.color = "#7ec3e8";
			n.pause.textContent = m.slowText;
		} else {
			n.pause.style.display = "none";
			n.pause.textContent = "";
		}

		// 详细诊断：直接显示引擎原始状态（版本有差异时这是最有用的信息）
		if (cfg.diag) {
			var d = diagLines();
			n.l6.style.display = "block";
			n.l7.style.display = "block";
			setNode(n.l6, d[0], "#8f9aa6");
			setNode(n.l7, d[1], "#8f9aa6");
			/* 快照由 tick 负责写，这里只显示 */
		} else {
			n.l6.style.display = "none";
			n.l7.style.display = "none";
		}
	}

	// ------------------------------------------------------------------ 配置界面

	function registerConfig() {
		try {
			if (typeof KDModConfigs !== "object" || KDModConfigs === null) {
				console.error(LOG_PREFIX + " KDModConfigs not found; the settings page will not appear.");
				return;
			}

			// 文本键的英文默认值先注册：下面的列表选项要立刻用 TextGet 取文字。
			// 中文由 Restless_CN.csv 覆盖同一个键。
			if (typeof addTextKey === "function") {
				for (var key in TEXT_KEYS) {
					if (Object.prototype.hasOwnProperty.call(TEXT_KEYS, key)) addTextKey(key, TEXT_KEYS[key]);
				}
			}

			KDModConfigs[MOD_ID] = [
				{ type: "boolean", refvar: "KDRLEnabled", default: DEFAULTS.KDRLEnabled },
				{ type: "list", refvar: "KDRLIndicator", name: "KDRLIndicator", options: optionLabels("KDRLIndicator"), default: optionLabel("KDRLIndicator", DEFAULTS.KDRLIndicator) },
				{ type: "list", refvar: "KDRLQuiet", name: "KDRLQuiet", options: optionLabels("KDRLQuiet"), default: optionLabel("KDRLQuiet", DEFAULTS.KDRLQuiet) },
				{ type: "list", refvar: "KDRLMode", name: "KDRLMode", options: optionLabels("KDRLMode"), default: optionLabel("KDRLMode", DEFAULTS.KDRLMode) },
				{ type: "range", refvar: "KDRLBaseInterval", name: "KDRLBaseInterval", default: DEFAULTS.KDRLBaseInterval, rangelow: 500, rangehigh: 15000, stepcount: 250 },
				{ type: "range", refvar: "KDRLLinear", name: "KDRLLinear", default: DEFAULTS.KDRLLinear, rangelow: 0, rangehigh: 1, stepcount: 0.05 },
				{ type: "range", refvar: "KDRLStage", name: "KDRLStage", default: DEFAULTS.KDRLStage, rangelow: 0, rangehigh: 1, stepcount: 0.05 },
				{ type: "range", refvar: "KDRLMinInterval", name: "KDRLMinInterval", default: DEFAULTS.KDRLMinInterval, rangelow: 250, rangehigh: 10000, stepcount: 250 },
				{ type: "range", refvar: "KDRLMaxInterval", name: "KDRLMaxInterval", default: DEFAULTS.KDRLMaxInterval, rangelow: 1000, rangehigh: 30000, stepcount: 500 },
				{ type: "range", refvar: "KDRLInspectSlow", name: "KDRLInspectSlow", default: DEFAULTS.KDRLInspectSlow, rangelow: 0, rangehigh: 12, stepcount: 1 },
				{ type: "range", refvar: "KDRLAimSlow", name: "KDRLAimSlow", default: DEFAULTS.KDRLAimSlow, rangelow: 0, rangehigh: 12, stepcount: 1 },
				{ type: "list", refvar: "KDRLPolarity", name: "KDRLPolarity", options: optionLabels("KDRLPolarity"), default: optionLabel("KDRLPolarity", DEFAULTS.KDRLPolarity) },
				{ type: "range", refvar: "KDRLJitter", name: "KDRLJitter", default: DEFAULTS.KDRLJitter, rangelow: 0, rangehigh: 0.3, stepcount: 0.05 },
				{ type: "boolean", refvar: "KDRLNotify", default: DEFAULTS.KDRLNotify },
				{ type: "boolean", refvar: "KDRLShowHud", default: DEFAULTS.KDRLShowHud },
				{ type: "boolean", refvar: "KDRLDebug", default: DEFAULTS.KDRLDebug },
				{ type: "boolean", refvar: "KDRLDiag", default: DEFAULTS.KDRLDiag },
			];
		} catch (err) {
			logError("registerConfig", err);
		}
	}

	/**
	 * 列表选项的文字随语言变（显示值同时是存进 KDModSettings 的值），
	 * 所以在画配置页之前按当前文本表重建一次；CSV 加载完才会拿到中文。
	 */
	function refreshOptionText() {
		try {
			var rows = (typeof KDModConfigs === "object" && KDModConfigs) ? KDModConfigs[MOD_ID] : null;
			var tab = settingsTab();
			if (rows) {
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					if (row.type !== "list" || !OPTION_KEYS[row.refvar]) continue;
					var labels = optionLabels(row.refvar);
					var changed = !row.options || row.options.length !== labels.length;
					for (var j = 0; !changed && j < labels.length; j++) {
						if (row.options[j] !== labels[j]) changed = true;
					}
					if (changed) {
						row.options = labels.slice();
						row.default = optionLabel(row.refvar, DEFAULTS[row.refvar]);
					}
				}
			}
			// 已存的值也要落到当前语言的显示值上，否则列表的 indexOf 找不到它。
			if (tab) syncOptionIds(tab);
		} catch (_e) { /* ignore */ }
	}

	// ------------------------------------------------------------------ 事件

	function wrapHandler(name, handler) {
		// 引擎的通用事件派发没有 try/catch：我们的 handler 抛错会破坏整帧，所以永远吞掉异常。
		return function () {
			try {
				handler.apply(this, arguments);
			} catch (err) {
				logError("事件 " + name, err);
			}
		};
	}

	function registerEvents() {
		try {
			if (typeof KDEventMapGeneric !== "object" || !KDEventMapGeneric) return;
			var handlers = {
				afterModSettingsLoad: function () { initDefaults(); localizeModListName(); resetTimers(); },
				afterLoadMods: function () { initDefaults(); localizeModListName(); },
				afterNewGame: function () { initDefaults(); resetTimers(); },
				afterLoadGame: function () { initDefaults(); resetTimers(); },
				afterChangeMap: function () { resetTimers(); },
			};
			for (var eventName in handlers) {
				if (!Object.prototype.hasOwnProperty.call(handlers, eventName)) continue;
				if (!KDEventMapGeneric[eventName] || typeof KDEventMapGeneric[eventName] !== "object") {
					KDEventMapGeneric[eventName] = {};
				}
				KDEventMapGeneric[eventName][MOD_ID] = wrapHandler(eventName, handlers[eventName]);
			}
		} catch (err) {
			logError("registerEvents", err);
		}
	}

	// ------------------------------------------------------------------ 驱动

	function installFrameHook() {
		if (typeof KinkyDungeonDrawGame !== "function") {
			state.frameHookOk = false;
			return false;
		}
		var originalDrawGame = KinkyDungeonDrawGame;
		KinkyDungeonDrawGame = function () {
			var result;
			var succeeded = true;
			try {
				result = originalDrawGame.apply(this, arguments);
			} catch (err) {
				// 原版帧函数自己出错：记下来并原样抛出（保持引擎行为），
				// 同时让兜底定时器在接下来 2 秒内不要替一个已经坏掉的帧循环推进回合。
				succeeded = false;
				state.lastDrawErrorAt = now();
				throw err;
			} finally {
				state.lastFrameAt = now();
				if (succeeded) {
					try {
						tick();
					} catch (err2) {
						logError("tick", err2);
					}
				}
			}
			return result;
		};
		state.frameHookOk = true;
		return true;
	}

	/** 只静默我们自己的强制等待文本，其它情况保持原样。 */
	function installWaitMessageHook() {
		if (typeof KinkyDungeonWaitMessage !== "function") return false;
		var originalWaitMessage = KinkyDungeonWaitMessage;
		KinkyDungeonWaitMessage = function (NoTime, delta, msg) {
			if (state.suppressWaitMsg) return originalWaitMessage(NoTime, delta, false);
			return originalWaitMessage(NoTime, delta, msg);
		};
		return true;
	}

	/** 画设置页之前补一次默认值（list 类型默认值 vanilla 从不写入）。 */
	function installConfigHook() {
		if (typeof KDDrawModConfigs !== "function") return false;
		var originalDrawModConfigs = KDDrawModConfigs;
		KDDrawModConfigs = function () {
			try { refreshOptionText(); initDefaults(); } catch (_e) { /* ignore */ }
			return originalDrawModConfigs.apply(this, arguments);
		};
		return true;
	}

	function startIntervalDriver() {
		try {
			if (state.timer) return;
			state.timer = setInterval(function () {
				try {
					if (typeof document !== "undefined" && document.hidden) return; // 后台标签页不偷偷推进
					// 帧钩子正常工作时由它驱动；只有钩子没跑（被别的东西覆盖/不存在）才接管
					if (state.frameHookOk && (now() - state.lastFrameAt) < 400) return;
					// 引擎的帧函数刚抛过错：先不接管，避免在"已经坏掉"的帧循环里偷偷推进
					var sinceDrawError = now() - state.lastDrawErrorAt;
					if (state.lastDrawErrorAt && sinceDrawError >= 0 && sinceDrawError < 2000) return;
					tick();
				} catch (err) {
					logError("interval", err);
				}
			}, 100);
			state.driver = state.frameHookOk ? "frame+interval" : "interval";
		} catch (err) {
			logError("startIntervalDriver", err);
			state.driver = state.frameHookOk ? "frame" : "none";
		}
	}

	// ------------------------------------------------------------------ 自检

	function doctor() {
		var symbols = [
			"KinkyDungeonState", "KinkyDungeonDrawState", "KDGameData", "KDMapData",
			"KinkyDungeonPlayerEntity", "KinkyDungeonPlayer", "KinkyDungeonStatStamina",
			"KinkyDungeonStatStaminaMax", "KinkyDungeonCurrentTick", "KDModSettings",
			"KDModConfigs", "KDEventMapGeneric", "KDDrawModConfigs", "addTextKey", "TextGet",
			"kdstatusboard", "kdstatusboardunder", "kdpixisprites",
			"KinkyDungeonGridSizeDisplay", "KinkyDungeonCamXVis", "KinkyDungeonCamYVis",
		];
		var functions = ["KDSendInput", "KinkyDungeonDrawGame", "KinkyDungeonWaitMessage",
			"KinkyDungeonMapGet", "KinkyDungeonTilesGet", "KinkyDungeonControlsEnabled",
			"KinkyDungeonSendActionMessage", "CommonTime",
			"FillCircleBarKD", "DrawCircleKD", "FillRectKD"];

		var engine = {};
		var missing = [];
		var i;
		for (i = 0; i < symbols.length; i++) {
			var t = typeOfSymbol(symbols[i]);
			engine[symbols[i]] = t;
			if (t === "undefined") missing.push(symbols[i]);
		}
		for (i = 0; i < functions.length; i++) {
			var tf = typeOfSymbol(functions[i]);
			engine[functions[i]] = tf;
			if (tf !== "function") missing.push(functions[i]);
		}

		var cfg = readCfg();
		var can = canAdvance();
		var loadedAtText = "";
		try { loadedAtText = new Date(state.loadedAt).toISOString(); } catch (_e) { loadedAtText = String(state.loadedAt); }
		var report = {
			mod: MOD_ID,
			version: VERSION,
			loadedAt: loadedAtText,
			driver: state.driver,
			frameHookOk: state.frameHookOk,
			frameHookAlive: state.frameHookOk && (now() - state.lastFrameAt) < 400,
			lastDrawErrorAt: state.lastDrawErrorAt,
			drawErrorRecently: !!(state.lastDrawErrorAt
				&& (now() - state.lastDrawErrorAt) >= 0 && (now() - state.lastDrawErrorAt) < 2000),
			hudCreated: !!state.hudEl,
			tickReady: state.ready,
			canAdvanceNow: can,
			reason: state.reason,
			reasonText: reasonText(state.reason),
			reasonDetail: state.reasonDetail,
			slowKind: state.slowKind,
			slowMult: state.mult,
			advanceCount: state.advanceCount,
			attempts: state.attempts,
			engineTypeOf: engine,
			missing: missing,
			settings: cfg,
			inGame: (typeof KinkyDungeonState !== "undefined" && KinkyDungeonState === "Game"),
			stamina: hasStamina() ? KinkyDungeonStatStamina : null,
			staminaMax: hasStamina() ? KinkyDungeonStatStaminaMax : null,
			tickNow: currentTick(),
			snapshot: engineSnapshot(),
		};

		try {
			console.log(LOG_PREFIX + " self-check report", report);
			if (missing.length) {
				console.warn(LOG_PREFIX + " missing engine symbols (the mod may not match this game version): " + missing.join(", "));
			}
		} catch (_e) { /* ignore */ }
		return report;
	}

	// ------------------------------------------------------------------ 安装

	function banner() {
		var missing = [];
		if (typeof KDSendInput !== "function") missing.push("KDSendInput");
		if (typeof KinkyDungeonDrawGame !== "function") missing.push("KinkyDungeonDrawGame");
		if (typeof KDModSettings === "undefined") missing.push("KDModSettings");
		if (typeof KDModConfigs === "undefined") missing.push("KDModConfigs");

		try {
			var cfgNow = readCfg();
			console.log(LOG_PREFIX + " v" + VERSION + " loaded"
				+ " · driver=" + state.driver
				+ " · frame hook=" + (state.frameHookOk ? "installed" : "not installed (interval fallback)")
				+ " · indicator=" + cfgNow.indicator
				+ " · slow: inspect x" + cfgNow.inspectSlow + " / aim x" + cfgNow.aimSlow
				+ " · debug panel=" + (cfgNow.showHud ? "on" : "off"));
			if (missing.length) console.warn(LOG_PREFIX + " missing: " + missing.join(", ") + "; check the game version (target 5.5.6).");
			console.log(LOG_PREFIX + " troubleshooting: run KDRestless.doctor() in the console for a self-check report.");
		} catch (_e) { /* ignore */ }
	}

	/**
	 * Mods 列表直接显示 mod.json 的 modname（不经 TextGet），按当前语言改写一次。
	 * 只改名字还等于内置名的条目，避免动到别的 mod。
	 * 展示时机由 installModListHook 负责：每次画列表前都会调它。
	 */
	function localizeModListName() {
		try {
			if (typeof KDModInfo !== "object" || !KDModInfo) return;
			var localized = say("KDRLModName");
			var known = [TEXT_KEYS.KDRLModName, "Restless", "无法安宁"];
			for (var key in KDModInfo) {
				if (!Object.prototype.hasOwnProperty.call(KDModInfo, key)) continue;
				var info = KDModInfo[key];
				if (!info || typeof info !== "object") continue;
				if (known.indexOf(String(info.modname)) < 0) continue;
				info.modname = localized;
				return;
			}
		} catch (_e) { /* ignore */ }
	}

	/**
	 * CSV 解析完成时间不定（加载器派发文件后不等解析），但玩家点开 Mods 页时译文早已就绪。
	 * 所以不去猜时间，而是包一层列表绘制入口：画之前把名字改对，什么机器都成立。
	 */
	function installModListHook() {
		if (typeof KDDrawMods !== "function") return false;
		var originalDrawMods = KDDrawMods;
		KDDrawMods = function () {
			try { localizeModListName(); } catch (_e) { /* ignore */ }
			return originalDrawMods.apply(this, arguments);
		};
		return true;
	}

	function install() {
		if (window.KDRestlessInstalled) {
			console.warn(LOG_PREFIX + " already installed, skipping (two copies of the mod file?)");
			return;
		}
		window.KDRestlessInstalled = true;
		state.loadedAt = now();

		try { registerConfig(); } catch (_e) { /* already logged */ }
		try { initDefaults(); } catch (_e) { /* ignore */ }
		try { registerEvents(); } catch (_e) { /* ignore */ }
		// mod.json 是静态文本，Mods 列表名只能在运行时改写；画列表之前改，不等 CSV 时序。
		localizeModListName();
		installModListHook();

		state.ready = (typeof KDSendInput === "function");
		installFrameHook();
		installWaitMessageHook();
		installConfigHook();
		startIntervalDriver();
		banner();

		// 调试 / 测试入口
		try {
			window.KDRestless = {
				version: VERSION,
				getState: function () {
					return {
						reason: state.reason,
						reasonText: reasonText(state.reason),
						reasonDetail: state.reasonDetail,
						active: state.active,
						lastAdvance: state.lastAdvance,
						interval: state.interval,
						stage: state.stage,
						advanceCount: state.advanceCount,
						attempts: state.attempts,
					};
				},
				getCfg: readCfg,
				getInterval: function () { return computeInterval(readCfg()); },
				/** 当前"子弹时间"状态（检视 / 瞄准慢放）。 */
				getSlow: function () {
					return {
						kind: state.slowKind,
						name: slowName(),
						mult: state.mult,
						baseInterval: state.baseInterval,
						interval: state.interval,
					};
				},
				reason: function () { canAdvance(); return state.reason; },
				doctor: doctor,
				snapshot: engineSnapshot,
				readDiag: function () {
					try { return window.localStorage.getItem("KDRestlessDiag"); } catch (_e) { return null; }
				},
				tick: function () { tick(); },
				forceAdvance: function () {
					if (canAdvance()) { advanceTurn(); return true; }
					return false;
				},
				setHud: function (on) {
					try {
						var tab = settingsTab();
						if (tab) tab.KDRLShowHud = !!on;
					} catch (_e) { /* ignore */ }
					renderHud();
				},
				_internals: {
					state: state,
					readCfg: readCfg,
					computeInterval: computeInterval,
					canAdvance: canAdvance,
					hudModel: hudModel,
					detectSlowKind: detectSlowKind,
					slowMultiplier: slowMultiplier,
					effectiveInterval: effectiveInterval,
					syncSlowInterval: syncSlowInterval,
					drawWorldIndicator: drawWorldIndicator,
					hideIndicator: hideIndicator,
					say: say,
					reasonText: reasonText,
					stageName: stageName,
					optionId: optionId,
					optionLabel: optionLabel,
					optionLabels: optionLabels,
					syncOptionIds: syncOptionIds,
					refreshOptionText: refreshOptionText,
					TEXT_KEYS: TEXT_KEYS,
					OPTION_KEYS: OPTION_KEYS,
					OPTION_IDS: OPTION_IDS,
					REASON_KEYS: REASON_KEYS,
					STAGE_NAME_KEYS: STAGE_NAME_KEYS,
				},
			};
		} catch (_e) { /* ignore */ }

		// 游戏若被嵌在 iframe 里（itch 页游 / 桌面壳），控制台默认上下文可能在顶层窗口，
		// 那里看不到本 frame 的 window.KDRestless。同源时顺手挂一份到 top / parent，
		// 跨源会被浏览器拦截（已 try/catch）。
		try {
			var api = window.KDRestless;
			if (api) {
				if (window.top && window.top !== window) window.top.KDRestless = api;
				if (window.parent && window.parent !== window) window.parent.KDRestless = api;
				if (typeof document !== "undefined" && document) document.KDRestless = api;
			}
		} catch (_e) { /* cross-origin iframe: ignore */ }

		// 立刻画一次面板：这就是"mod 有没有被执行"的第一信号
		try { renderHud(); } catch (_e) { /* ignore */ }
	}

	// 顶层再包一层：即使安装阶段意外抛错，也只损失本 mod 的功能，
	// 绝不让异常冒到 KDMods 的 await eval（那会让整个 mod 加载链挂死、吞掉鼠标点击）。
	try {
		install();
	} catch (err) {
		try {
			console.error(LOG_PREFIX + " install failed (the mod is inactive, the game is not blocked):", err);
		} catch (_e) { /* ignore */ }
	}
})();
