/**
 * 信号缺失检测助手 (Signal Absence Detection)
 *
 * 检测原理图中的单连接网络并沿导线描线高亮，供设计评审参考：
 *  - 有名网络仅 1 个器件连接（如 MCU 引脚 + 网络标签，标签在整张原理图中无对端）
 *  - 有名网络 0 器件连接（仅悬空网络标签 / 网络端口）
 *  - 未命名（空网络名）孤立导线仅连接 1 个器件（如开关悬空的一侧）
 *  - 悬空导线（无任何连接）与孤立引脚（未连任何导线，且无非连接标识）
 *
 * 判定规则：网络按「同一张原理图（跨图页）」为作用域，导线先按几何连通性
 * 分组（端点重合 / 端点落线段；十字交叉不合并），再按网络名跨图页合并；
 * 电源标识符（VCC/GND 等）视为有效连接，但其名字悬空（仅覆盖 1 个连通组）
 * 时不豁免 —— 误输入的电源名（如 MCU_3V3123）不会屏蔽自身；同名网络
 * 标签 / 端口出现多次即合并为同一网络（多图页连接的正确表达）。
 * 检测范围 = 当前活动图页所属板子的全部原理图页，其余板子不检测。
 * 短接符号（Short-Symbol，short_symbol）两引脚间视为导线直连：桥接的
 * 连通组跨岛合并、网络名互通，且不计入器件数（连接性等价于导线）。
 * 网络标签 / 端口代替导线直连：其网络名并入所在连通组的网络名集合，
 * 同名连通组跨岛 / 跨图页合并判定；标签直贴无导线引脚时以该引脚建立
 * 伪连通组参与合并。合并后按「有效连接」判定单连接：网络名把 >= 2 个
 * 连通组连成一张网（跨图页同名 / 标签代替导线）视为名字生效；单一
 * 网络名仅覆盖 1 个连通组则标签无对端 —— 即使组内器件已通过导线直连
 * （如 R13 与 U8 直连、EN2.8V 标签无对端），标签也没有建立任何连接，
 * 仍判为单连接（悬空标签）。
 *
 * 高亮机制：dmt_EditorControl.generateIndicatorMarkers 沿导线画标记线
 * （不随点击消失），孤立引脚沿引脚方向画短标记。
 *
 * 配置：高亮颜色/线宽、单连接判定阈值（器件数）、电源标识符与短接符号
 * 是否视为有效连接、各检测项开关，经设置面板（iframe/config.html）修改并
 * 持久化于 sys_Storage。
 *
 * 打包格式：EasyEDA 加载器将入口文件作为普通脚本求值（不支持 ES Module），
 * 顶层函数声明对接 registerFn 调度，并挂载 edaEsbuildExportName 兼容官方 SDK 产物。
 *
 * 注：ESCH_PrimitiveComponentType / EDMT_EditorDocumentType 为字符串/数字枚举，
 *     此处直接使用文档化的字面值。
 */

const REPORT_KEY = 'signalAbsenceDetection.report';
const CONFIG_KEY = 'signalAbsenceDetection.config';

/** 默认配置（用户可经设置面板修改，持久化于 sys_Storage） */
const DEFAULT_CONFIG = {
	highlightColor: '#e63228', // 高亮颜色 '#rrggbb'
	lineWidth: 3, // 标记线宽
	maxPartCount: 1, // 器件数 <= 该值判为单连接（0 = 仅报告无器件连接）
	netFlagAsConnected: true, // 电源网络标识符（VCC/GND 等）视为有效连接
	shortSymbolAsWire: true, // 短接符号（Short-Symbol）视为导线连接
	kinds: {
		single: true, // 有名网络仅 N 个器件
		nopin: true, // 有名网络 0 器件连接
		unnamed: true, // 未命名网络仅 N 个器件
		'lone-wire': true, // 悬空导线
		'isolated-pin': true, // 孤立引脚
	},
};

/** ESCH_PrimitiveComponentType 枚举字面值（short_symbol 未见于公开枚举，按实际返回值） */
const COMP_TYPE = {
	PART: 'part',
	NET_FLAG: 'netflag',
	NET_LABEL: 'netlabel',
	NET_PORT: 'netport',
	SHORT_SYMBOL: 'short_symbol',
};

/** EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1 */
const DOC_TYPE_SCHEMATIC_PAGE = 1;

const DEFAULT_COLOR = '#e63228';
/** 孤立引脚短标记长度（原理图单位 0.01inch） */
const PIN_STUB_LEN = 7;

/** 读取配置（与默认值深合并并做合法性约束） */
function loadConfig() {
	const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
	try {
		const raw = eda.sys_Storage.getExtensionUserConfig(CONFIG_KEY);
		if (raw) {
			const saved = JSON.parse(raw);
			if (saved && typeof saved === 'object') {
				for (const k of ['highlightColor', 'lineWidth', 'maxPartCount', 'netFlagAsConnected', 'shortSymbolAsWire']) {
					if (saved[k] !== undefined) cfg[k] = saved[k];
				}
				if (saved.kinds && typeof saved.kinds === 'object') {
					for (const k of Object.keys(DEFAULT_CONFIG.kinds)) {
						if (saved.kinds[k] !== undefined) cfg.kinds[k] = !!saved.kinds[k];
					}
				}
			}
		}
	} catch (e) {
		/* 存储损坏时回退默认配置 */
	}
	if (!/^#[0-9a-fA-F]{6}$/.test(String(cfg.highlightColor))) cfg.highlightColor = DEFAULT_CONFIG.highlightColor;
	cfg.lineWidth = Math.min(10, Math.max(1, Math.round(Number(cfg.lineWidth) || DEFAULT_CONFIG.lineWidth)));
	cfg.maxPartCount = Math.min(5, Math.max(0, Math.round(Number(cfg.maxPartCount)))) || 0;
	cfg.netFlagAsConnected = !!cfg.netFlagAsConnected;
	cfg.shortSymbolAsWire = !!cfg.shortSymbolAsWire;
	return cfg;
}

/** 发现类型 -> 中文说明 */
const KIND_LABEL = {
	single: '单连接（器件数不足或名字无对端）',
	nopin: '无器件连接（悬空标签/端口）',
	unnamed: '未命名网络（仅 1 个器件）',
	'lone-wire': '悬空导线（无任何连接）',
	'isolated-pin': '孤立引脚（未连导线）',
};

/* ===================== 几何与连通性 ===================== */

const pkey = (x, y) => Math.round(x * 100) / 100 + ',' + Math.round(y * 100) / 100;

/**
 * 解析导线 line 数据。
 * 格式为线段端点对序列：[x1,y1,x2,y2, x3,y3,x4,y4, ...]（每 4 个数一段），
 * 零长度段为结点（junction），仅贡献端点不贡献线段。
 */
function parseWire(line) {
	const pts = [];
	const segs = [];
	if (!Array.isArray(line) || line.length < 4) return { pts, segs };
	const polys = typeof line[0] === 'number' ? [line] : line;
	for (const poly of polys) {
		if (!Array.isArray(poly)) continue;
		for (let i = 0; i + 3 < poly.length; i += 4) {
			const x1 = poly[i], y1 = poly[i + 1], x2 = poly[i + 2], y2 = poly[i + 3];
			pts.push([x1, y1], [x2, y2]);
			if (x1 === x2 && y1 === y2) continue;
			segs.push([x1, y1, x2, y2]);
		}
	}
	return { pts, segs };
}

const pointOnSeg = (px, py, s) => {
	const cross = (s[2] - s[0]) * (py - s[1]) - (s[3] - s[1]) * (px - s[0]);
	if (Math.abs(cross) > 0.01) return false;
	return Math.min(s[0], s[2]) - 0.01 <= px && px <= Math.max(s[0], s[2]) + 0.01 && Math.min(s[1], s[3]) - 0.01 <= py && py <= Math.max(s[1], s[3]) + 0.01;
};

/** '#rrggbb' -> {r,g,b,alpha} */
function parseColor(hex) {
	const m = /^#?([0-9a-fA-F]{6})$/.test(hex) ? hex.slice(-6) : DEFAULT_COLOR.slice(-6);
	return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16), alpha: 255 };
}

/* ===================== 检测核心 ===================== */

/** 获取元件引脚（实例 getAllPins 优先，回退类方法），返回 [{pinNumber, x, y, rotation, noConnected}] */
async function getPartPins(component) {
	let pins = [];
	try {
		pins = (await component.getAllPins()) || [];
	} catch (e) {
		try {
			pins = (await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(component.getState_PrimitiveId())) || [];
		} catch (e2) {
			pins = [];
		}
	}
	return pins;
}

/**
 * 按类型获取元件。
 * 按类型字面值过滤优先；若该类型未被 getAll 接受则回退全量枚举 +
 * getState_ComponentType 过滤（short_symbol / netlabel 等字面值未见于公开枚举文档）。
 */
async function getCompsByType(type) {
	let comps = [];
	try {
		comps = (await eda.sch_PrimitiveComponent.getAll(type, false)) || [];
	} catch (e) {
		comps = [];
	}
	if (comps.length === 0) {
		try {
			const all = (await eda.sch_PrimitiveComponent.getAll()) || [];
			comps = all.filter((c) => {
				try {
					return String(c.getState_ComponentType()) === type;
				} catch (e) {
					return false;
				}
			});
		} catch (e) {
			comps = [];
		}
	}
	return comps;
}

/**
 * 分析单个图页：导线几何分组 + 引脚/标识符挂接。
 * @returns {{groups: Map, isolatedPins: Array, endpointMap: Map, wireCount: number}}
 * groups: 连通组 {nets:[name], wires:[{id,segs}], pins:[ref], parts:Set, labels:[], flags:[], ports:[]}
 */
async function analyzePage(cfg) {
	const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
	const wd = [];
	for (const w of wires) {
		const { pts, segs } = parseWire(w.getState_Line());
		wd.push({ id: w.getState_PrimitiveId(), net: w.getState_Net() || '', pts, segs });
	}

	/* union-find：端点重合 -> 同组；端点落在其它导线线段上（T 型连接）-> 同组 */
	const parent = wd.map((_, i) => i);
	const find = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a, b) => {
		parent[find(a)] = find(b);
	};

	const endpointMap = new Map();
	wd.forEach((w, i) => {
		for (const p of w.pts) {
			const k = pkey(p[0], p[1]);
			if (!endpointMap.has(k)) endpointMap.set(k, []);
			endpointMap.get(k).push(i);
		}
	});
	for (const idxs of endpointMap.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
	for (const [k, idxs] of endpointMap) {
		const [px, py] = k.split(',').map(Number);
		const root = idxs[0];
		for (let j = 0; j < wd.length; j++) {
			if (find(j) === find(root)) continue;
			if (wd[j].segs.some((s) => pointOnSeg(px, py, s))) union(root, j);
		}
	}

	/** 坐标 -> 连通组根（先查端点表再查线段覆盖） */
	const pinGroup = (x, y) => {
		const k = pkey(x, y);
		if (endpointMap.has(k)) return find(endpointMap.get(k)[0]);
		for (let j = 0; j < wd.length; j++) {
			if (wd[j].segs.some((s) => pointOnSeg(x, y, s))) return find(j);
		}
		return null;
	};

	/* 短接符号（Short-Symbol）：两引脚间视为导线直连 —— 引脚所在连通组
	   跨岛合并（须在 groups 构建前完成），不计入器件数；可在配置中关闭 */
	if (cfg.shortSymbolAsWire) {
		const shorts = await getCompsByType(COMP_TYPE.SHORT_SYMBOL);
		for (const c of shorts) {
			const pins = await getPartPins(c);
			const roots = [];
			for (const p of pins) {
				const r = pinGroup(p.x, p.y);
				if (r !== null) roots.push(r);
			}
			for (let i = 1; i < roots.length; i++) union(roots[0], roots[i]);
		}
	}

	const groups = new Map();
	wd.forEach((w, i) => {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, { nets: [], wires: [], pins: [], parts: new Set(), labels: [], flags: [], ports: [], pinPts: [] });
		const g = groups.get(r);
		if (w.net && !g.nets.includes(w.net)) g.nets.push(w.net);
		g.wires.push(w);
	});

	/* 元件引脚挂接；未落导线的引脚暂存（可能被网络标签/标识符锚定，不直接判孤立） */
	const parts = (await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.PART, false)) || [];
	const wirelessPins = new Map(); // pkey -> {ref, des, x, y, rotation}
	for (const c of parts) {
		const des = c.getState_Designator() || '?';
		const pins = await getPartPins(c);
		for (const p of pins) {
			let nc = false;
			try {
				nc = typeof p.getState_NoConnected === 'function' ? p.getState_NoConnected() : !!p.noConnected;
			} catch (e) {
				nc = false;
			}
			if (nc) continue;
			const g = pinGroup(p.x, p.y);
			if (g !== null) {
				const grp = groups.get(g);
				grp.pins.push(des + '_' + (p.pinNumber || '?'));
				grp.parts.add(des);
				grp.pinPts.push({ x: p.x, y: p.y, rotation: p.rotation || 0 });
			} else {
				wirelessPins.set(pkey(p.x, p.y), { ref: des + '_' + (p.pinNumber || '?'), des: des, x: p.x, y: p.y, rotation: p.rotation || 0 });
			}
		}
	}

	/* 网络标识符 / 网络标签 / 网络端口挂接（元件原点即连接点）：
	   - 落在导线连通组：计入对应列表，且网络名并入组网络名集合 —— 网络标签
	     代替导线直连，同名连通组（含跨图页）据此合并判定；
	   - 落在无导线引脚上：以该引脚建立伪连通组（标签直贴引脚）；
	   - 空悬：忽略 */
	for (const [ct, key] of [[COMP_TYPE.NET_FLAG, 'flags'], [COMP_TYPE.NET_LABEL, 'labels'], [COMP_TYPE.NET_PORT, 'ports']]) {
		const comps = await getCompsByType(ct);
		for (const c of comps) {
			const net = c.getState_Net() || '';
			const g = pinGroup(c.getState_X(), c.getState_Y());
			if (g !== null) {
				const grp = groups.get(g);
				grp[key].push(net);
				if (net && !grp.nets.includes(net)) grp.nets.push(net);
			} else {
				const wp = wirelessPins.get(pkey(c.getState_X(), c.getState_Y()));
				if (wp) {
					const gk = 'pin@' + pkey(wp.x, wp.y);
					let grp = groups.get(gk);
					if (!grp) {
						grp = { nets: [], wires: [], pins: [], parts: new Set(), labels: [], flags: [], ports: [], pinPts: [] };
						groups.set(gk, grp);
					}
					grp[key].push(net);
					if (net && !grp.nets.includes(net)) grp.nets.push(net);
					grp.pins.push(wp.ref);
					grp.parts.add(wp.des);
					grp.pinPts.push({ x: wp.x, y: wp.y, rotation: wp.rotation });
					wirelessPins.delete(pkey(wp.x, wp.y));
				}
			}
		}
	}

	const isolatedPins = Array.from(wirelessPins.values(), (wp) => ({ ref: wp.ref, x: wp.x, y: wp.y, rotation: wp.rotation }));
	return { groups, isolatedPins };
}

/**
 * 板级检测：范围 = 当前活动图页所属板子的原理图全部图页（作用域=单张
 * 原理图，跨图页按网络名合并）；其余板子不检测。
 * @returns {{findings: Array, pageUuids: Array<string>}}
 */
async function detectAll(cfg) {
	const schematics = (await eda.dmt_Schematic.getAllSchematicsInfo()) || [];
	const schematicNames = new Map(schematics.map((s) => [s.uuid, s.name || '原理图']));
	const pagesAll = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
	const bySchematic = new Map();
	for (const pg of pagesAll) {
		const sid = pg.parentSchematicUuid || pg.uuid;
		if (!bySchematic.has(sid)) bySchematic.set(sid, []);
		bySchematic.get(sid).push({ uuid: pg.uuid, name: pg.name || pg.uuid.slice(0, 6) });
	}

	const origDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	/* 检测范围 = 当前活动图页所属板子：即其原理图下的全部图页（跨图页合并
	   判定不变）；其余板子（其他原理图）不检测。独立原理图（不挂板子）
	   以该原理图自身为范围。 */
	const scopeSid = origDoc && origDoc.uuid ? (pagesAll.find((pg) => pg.uuid === origDoc.uuid) || {}).parentSchematicUuid : null;
	if (!scopeSid || !bySchematic.has(scopeSid)) throw new Error('无法确定当前图页所属的板子（原理图），请确认已打开工程内的原理图页面');
	const scopedBySchematic = new Map([[scopeSid, bySchematic.get(scopeSid)]]);

	const findings = [];
	const pageUuids = [];

	try {
		for (const [sid, pages] of scopedBySchematic) {
			const pageNames = new Map(pages.map((pg) => [pg.uuid, pg.name]));
			const namedGroups = [];

			for (const pg of pages) {
				await eda.dmt_EditorControl.openDocument(pg.uuid);
				pageUuids.push(pg.uuid);
				const { groups, isolatedPins } = await analyzePage(cfg);

				for (const g of groups.values()) {
					if (g.nets.length > 0) {
						namedGroups.push({ g, pg });
					} else if (g.parts.size <= cfg.maxPartCount && (!cfg.netFlagAsConnected || g.flags.length === 0)) {
						/* 未命名孤立网络：器件数 <= 阈值且（可选）无电源符号 */
						const kind = g.parts.size > 0 ? 'unnamed' : 'lone-wire';
						if (cfg.kinds[kind]) {
							const segs = [];
							for (const w of g.wires) for (const s of w.segs) segs.push(s);
							const pinStubs = segs.length === 0 ? g.pinPts.map((pt) => ({ pageUuid: pg.uuid, x: pt.x, y: pt.y, rotation: pt.rotation })) : [];
							findings.push({
								schematic: schematicNames.get(sid) || sid.slice(0, 8),
								net: '(未命名网络)',
								kind: kind,
								pins: g.pins.slice(),
								parts: Array.from(g.parts),
								labels: 0,
								ports: 0,
								pages: [pg.uuid],
								pageNames: [pg.name],
								pageSegs: [{ pageUuid: pg.uuid, segs }],
								pinStubs: pinStubs,
							});
						}
					}
				}

				for (const ip of isolatedPins) {
					if (!cfg.kinds['isolated-pin']) break;
					findings.push({
						schematic: schematicNames.get(sid) || sid.slice(0, 8),
						net: '(孤立引脚)',
						kind: 'isolated-pin',
						pins: [ip.ref],
						parts: [ip.ref.split('_')[0]],
						labels: 0,
						ports: 0,
						pages: [pg.uuid],
						pageNames: [pg.name],
						pinStubs: [{ pageUuid: pg.uuid, x: ip.x, y: ip.y, rotation: ip.rotation }],
					});
				}
			}

			/* 名字并查集：同名网络跨图页合并；短接符号桥接的连通组可能同时
			   携带多个网络名（如 PA9 + UART_RXD），一并归入同一等价类 */
			const nameParent = new Map();
			const findName = (n) => {
				while (nameParent.has(n) && nameParent.get(n) !== n) n = nameParent.get(n);
				return n;
			};
			for (const { g } of namedGroups) {
				for (const n of g.nets) if (!nameParent.has(n)) nameParent.set(n, n);
				for (let i = 1; i < g.nets.length; i++) {
					const ra = findName(g.nets[0]);
					const rb = findName(g.nets[i]);
					if (ra !== rb) nameParent.set(ra, rb);
				}
			}

			/* 按等价类合并全部有名连通组 */
			const merged = new Map();
			const getM = (key) => {
				if (!merged.has(key)) merged.set(key, { names: [], pins: [], parts: new Set(), labels: 0, ports: 0, flags: 0, islands: 0, pageSegs: new Map(), pagePinPts: new Map(), pages: new Set() });
				return merged.get(key);
			};
			for (const { g, pg } of namedGroups) {
				const m = getM(findName(g.nets[0]));
				for (const n of g.nets) if (!m.names.includes(n)) m.names.push(n);
				for (const p of g.pins) m.pins.push(p);
				for (const p of g.parts) m.parts.add(p);
				m.labels += g.labels.length;
				m.ports += g.ports.length;
				m.flags += g.flags.length;
				m.islands += 1;
				m.pages.add(pg.uuid);
				const segs = [];
				for (const w of g.wires) for (const s of w.segs) segs.push(s);
				m.pageSegs.set(pg.uuid, (m.pageSegs.get(pg.uuid) || []).concat(segs));
				m.pagePinPts.set(pg.uuid, (m.pagePinPts.get(pg.uuid) || []).concat(g.pinPts));
			}

			/* 有名网络判定（两种情形均判为单连接）：
			   1) 器件数 <= 阈值，且（可选）无电源标识符；
			   2) 悬空名字：单一网络名仅覆盖 1 个连通组 —— 名字（标签/电源标识符）
			      本应代替导线把本组与别处同名组相连，实际无对端；此时即使组内
			      器件已通过导线直连（如 R13-U8 直连 + EN2.8V 标签），名字也没有
			      建立任何连接。此情形不受电源标识符豁免 —— 否则误输入的电源名
			      （如 MCU_3V3123 仅挂 1 个连通组）会屏蔽自身导致漏报。
			      （阈值设为 0 = 仅报告无器件连接时，本情形不生效） */
			for (const m of merged.values()) {
				const kind = m.parts.size > 0 ? 'single' : 'nopin';
				const danglingLabel = m.names.length === 1 && m.islands <= 1 && m.parts.size > 0 && cfg.maxPartCount >= 1;
				const reason = m.parts.size <= cfg.maxPartCount ? 'parts<=threshold' : 'dangling-label';
				if ((m.parts.size <= cfg.maxPartCount || danglingLabel) && (!cfg.netFlagAsConnected || m.flags === 0 || danglingLabel) && cfg.kinds[kind]) {
					/* 无线段图页（标签直贴引脚等）以引脚短标记呈现 */
					const pinStubs = [];
					for (const [u, segs] of m.pageSegs) {
						if (segs.length === 0) {
							for (const pt of m.pagePinPts.get(u) || []) pinStubs.push({ pageUuid: u, x: pt.x, y: pt.y, rotation: pt.rotation });
						}
					}
					findings.push({
						schematic: schematicNames.get(sid) || sid.slice(0, 8),
						net: m.names.join(' / '),
						kind: kind,
						reason: reason,
						islands: m.islands,
						pins: m.pins.slice(),
						parts: Array.from(m.parts),
						labels: m.labels,
						ports: m.ports,
						pages: Array.from(m.pages),
						pageNames: Array.from(m.pages, (u) => pageNames.get(u) || u.slice(0, 6)),
						pageSegs: Array.from(m.pageSegs, ([pageUuid, segs]) => ({ pageUuid, segs })),
						pinStubs: pinStubs,
					});
				}
			}
		}
	} finally {
		if (origDoc && origDoc.uuid) await eda.dmt_EditorControl.openDocument(origDoc.uuid);
	}

	findings.sort((a, b) => (a.schematic + a.net).localeCompare(b.schematic + b.net, 'zh-Hans'));
	return { findings, pageUuids };
}

/* ===================== 高亮 ===================== */

/** 在指定图页生成标记线（tabId 缺省时作用于「最后输入焦点的画布」，须显式传入避免误绘/残留焦点态） */
async function paintMarkers(segs, pinStubs, color, lineWidth, tabId) {
	const markers = [];
	for (const s of segs) markers.push({ type: 'line', startX: s[0], startY: s[1], endX: s[2], endY: s[3] });
	for (const st of pinStubs || []) {
		const dir = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[st.rotation] || [1, 0];
		markers.push({ type: 'line', startX: st.x, startY: st.y, endX: st.x + dir[0] * PIN_STUB_LEN, endY: st.y + dir[1] * PIN_STUB_LEN });
	}
	if (markers.length === 0) return true;
	return eda.dmt_EditorControl.generateIndicatorMarkers(markers, color, lineWidth, false, tabId);
}

/** 遍历图页逐页描线（findings 中含每页的线段/引脚数据），显式指定目标画布 */
async function paintFindings(findings, cfg) {
	const byPage = new Map();
	for (const f of findings) {
		for (const ps of f.pageSegs || []) {
			if (!byPage.has(ps.pageUuid)) byPage.set(ps.pageUuid, { segs: [], pinStubs: [] });
			byPage.get(ps.pageUuid).segs.push(...ps.segs);
		}
		for (const st of f.pinStubs || []) {
			if (!byPage.has(st.pageUuid)) byPage.set(st.pageUuid, { segs: [], pinStubs: [] });
			byPage.get(st.pageUuid).pinStubs.push(st);
		}
	}
	const color = parseColor(cfg.highlightColor);
	for (const [pageUuid, data] of byPage) {
		const tabId = await eda.dmt_EditorControl.openDocument(pageUuid);
		await paintMarkers(data.segs, data.pinStubs, color, cfg.lineWidth, tabId);
	}
}

/* ===================== 菜单入口 ===================== */

/** 确保当前活动文档为原理图页面 */
async function ensureSchematicActive() {
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!doc || doc.documentType !== DOC_TYPE_SCHEMATIC_PAGE) {
		eda.sys_Message.showToastMessage('请先打开一个原理图页面再执行此操作', 'warn');
		return false;
	}
	return true;
}

async function detectAndHighlight() {
	try {
		if (!(await ensureSchematicActive())) return;
		eda.sys_Message.showToastMessage('正在检测当前板子的全部原理图页...', 'info');

		const origDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		const cfg = loadConfig();
		const { findings, pageUuids } = await detectAll(cfg);

		/* 仅清除检测范围内（当前板子）图页的旧标记（removeIndicatorMarkers
		   不传 tabId 仅作用于最后输入焦点的画布，须逐页显式指定）；其余板子
		   不触碰，历史版本的全工程残留标记可经菜单「清除高亮」移除 */
		for (const pgUuid of pageUuids) {
			const tabId = await eda.dmt_EditorControl.openDocument(pgUuid);
			await eda.dmt_EditorControl.removeIndicatorMarkers(tabId);
		}

		await paintFindings(findings, cfg);

		/* 回到检测前所在图页：标记操作（不传 tabId 时作用于「最后输入焦点的画布」）
		   引发的焦点切换会让右侧属性面板停留在多选摘要状态，显式 tabId + 复位
		   所在页即可消除；注意 clearSelected 会一并清除指示标记，故画标记后不再调用 */
		if (origDoc && origDoc.uuid) {
			const cur = await eda.dmt_SelectControl.getCurrentDocumentInfo();
			if (!cur || cur.uuid !== origDoc.uuid) await eda.dmt_EditorControl.openDocument(origDoc.uuid);
		}

		try {
			eda.sys_Storage.setExtensionUserConfig(REPORT_KEY, JSON.stringify({ time: Date.now(), findings, pageUuids }));
		} catch (e) {
			/* 报告存储失败不影响高亮结果 */
		}

		if (findings.length === 0) {
			eda.sys_Message.showToastMessage('未发现单连接网络', 'success');
			return;
		}
		const names = findings.map((f) => f.net);
		const brief = names.length > 6 ? names.slice(0, 6).join('、') + ` 等 ${names.length} 项` : names.join('、');
		eda.sys_Message.showToastMessage(`发现 ${findings.length} 处单连接网络：${brief}（菜单「查看检测报告」可打开详情）`, 'success');
	} catch (e) {
		eda.sys_Message.showToastMessage(`执行出错: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

async function clearHighlight() {
	try {
		const origDoc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
		const pagesAll = (await eda.dmt_Schematic.getAllSchematicPagesInfo()) || [];
		for (const pg of pagesAll) {
			const tabId = await eda.dmt_EditorControl.openDocument(pg.uuid);
			await eda.dmt_EditorControl.removeIndicatorMarkers(tabId);
		}
		if (origDoc && origDoc.uuid) await eda.dmt_EditorControl.openDocument(origDoc.uuid);
		eda.sch_SelectControl.clearSelected();
		eda.sys_Message.showToastMessage('已清除全部高亮标记', 'success');
	} catch (e) {
		eda.sys_Message.showToastMessage(`执行出错: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

async function openReport() {
	try {
		await eda.sys_IFrame.openIFrame('/iframe/index.html', 760, 540, 'sad-report', {
			title: '信号缺失检测助手 - 检测报告',
			minimizeButton: true,
			maximizeButton: false,
		});
	} catch (e) {
		eda.sys_Message.showToastMessage(`打开报告面板失败: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

async function openConfig() {
	try {
		await eda.sys_IFrame.openIFrame('/iframe/config.html', 460, 560, 'sad-config', {
			title: '信号缺失检测助手 - 设置',
			minimizeButton: true,
			maximizeButton: false,
		});
	} catch (e) {
		eda.sys_Message.showToastMessage(`打开设置面板失败: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

/* 官方 SDK esbuild 产物以 iife + globalName 暴露导出，此处等价挂载以保持兼容 */
var edaEsbuildExportName = { detectAndHighlight: detectAndHighlight, clearHighlight: clearHighlight, openReport: openReport, openConfig: openConfig };
