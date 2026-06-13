const state = {
  entities: [],
  selectedEntityIds: [],
  activeDxfFile: null,
  isProcessing: false,
  processingError: "",
  transportGeoJson: null,
  planningBounds: null,
  currentHighlights: [],
  currentLayoutData: null,
  hoveredLayoutFeatureId: null,
  layoutEvidenceOpen: false,
  questionBankOpen: false,
  featureToEntityIds: {},
  entityToFeatureIds: {},
  conversationHistory: [],
  graphScale: 1,
  currentSubgraph: { nodes: [], edges: [] },
  graphLabelOffsets: {},
  activeGraphLabelDrag: null,
};

const TRACK_CLASS_COLORS = {
  one_way_no_pedestrian: "#e41a1c",
  one_way_with_pedestrian: "#ff7f00",
  two_way_no_pedestrian: "#377eb8",
  two_way_with_pedestrian: "#984ea3",
};

const DEMO_DRAWING = "Beispiel_ganze_Halle.dxf";
const DEMO_TRANSPORT_PATH = "data/Beispiel_ganze_Halle__transport_track_plan.geojson";
let demoDataPromise = null;

function normalizeQuestionText(question) {
  return String(question || "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function loadDemoData() {
  if (!demoDataPromise) {
    demoDataPromise = Promise.all([
      window.fetch("data/kg_nodes.json").then((response) => response.json()),
      window.fetch("data/kg_triples.json").then((response) => response.json()),
      window.fetch("data/question_bank.json").then((response) => response.json()),
      window.fetch("data/qa_answers.json").then((response) => response.json()),
    ]).then(([nodes, triples, questionBank, qaAnswers]) => ({
      nodes,
      triples,
      questionBank,
      answersByQuestion: new Map(
        (qaAnswers.answers || []).map((answer) => [normalizeQuestionText(answer.question), answer]),
      ),
    }));
  }
  return demoDataPromise;
}

async function staticApiRequest(url, options = {}) {
  const data = await loadDemoData();
  const parsed = new URL(url, window.location.href);

  if (parsed.pathname === "/api/health") {
    return { cached_answer_count: data.answersByQuestion.size };
  }
  if (parsed.pathname === "/api/dxf-files") {
    return { files: [{ name: DEMO_DRAWING }] };
  }
  if (parsed.pathname === "/api/process-dxf") {
    return { artifacts: { transport_geojson: DEMO_TRANSPORT_PATH } };
  }
  if (parsed.pathname === "/api/schema") {
    return {
      schema: {
        entity_types: data.nodes.metadata.entity_types || [],
        relation_types: data.nodes.metadata.relation_types || [],
        metadata: data.nodes.metadata,
      },
    };
  }
  if (parsed.pathname === "/api/entities") {
    return { entities: data.nodes.nodes || [] };
  }
  if (parsed.pathname === "/api/question-bank") {
    return data.questionBank;
  }
  if (parsed.pathname === "/api/subgraph") {
    const nodeId = parsed.searchParams.get("node_id");
    const edges = (data.triples.triples || []).filter(
      (edge) => edge.subject === nodeId || edge.object === nodeId,
    );
    const nodeIds = new Set([nodeId]);
    edges.forEach((edge) => {
      nodeIds.add(edge.subject);
      nodeIds.add(edge.object);
    });
    return {
      nodes: (data.nodes.nodes || []).filter((node) => nodeIds.has(node.node_id)),
      edges,
    };
  }
  if (parsed.pathname === "/api/ask") {
    const request = JSON.parse(options.body || "{}");
    const answer = data.answersByQuestion.get(normalizeQuestionText(request.question));
    if (answer) {
      return answer;
    }
    return {
      answer_text: "This static demo answers the curated question bank only. Select a stored question to view its grounded answer.",
      referenced_entities: [],
      referenced_relations: [],
      highlights: [],
    };
  }
  throw new Error(`Unsupported static demo endpoint: ${parsed.pathname}`);
}

async function fetchJson(url, options = {}) {
  if (url.startsWith("/api/")) {
    return staticApiRequest(url, options);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    let detail = `Request failed: ${response.status}`;
    try {
      const payload = await response.json();
      detail = payload.error?.message || detail;
    } catch (_) {
      // Keep the HTTP status fallback when the response is not JSON.
    }
    throw new Error(detail);
  }
  return response.json();
}

function qs(id) {
  return document.getElementById(id);
}

function getEdgeKey(edge) {
  return `${edge.subject}__${edge.predicate}__${edge.object}`;
}

function getNodeLabelKey(node) {
  return `node__${node.node_id}`;
}

function toSvgPoint(svg, clientX, clientY) {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;
  return point.matrixTransform(svg.getScreenCTM().inverse());
}

function startGraphLabelDrag(event, labelKey) {
  event.preventDefault();
  event.stopPropagation();
  const svg = qs("graphView");
  const startPoint = toSvgPoint(svg, event.clientX, event.clientY);
  const existingOffset = state.graphLabelOffsets[labelKey] || { x: 0, y: 0 };
  state.activeGraphLabelDrag = { labelKey, startPoint, existingOffset };
}

function updateGraphLabelDrag(event) {
  if (!state.activeGraphLabelDrag) {
    return;
  }
  const svg = qs("graphView");
  const currentPoint = toSvgPoint(svg, event.clientX, event.clientY);
  state.graphLabelOffsets[state.activeGraphLabelDrag.labelKey] = {
    x: state.activeGraphLabelDrag.existingOffset.x + (currentPoint.x - state.activeGraphLabelDrag.startPoint.x),
    y: state.activeGraphLabelDrag.existingOffset.y + (currentPoint.y - state.activeGraphLabelDrag.startPoint.y),
  };
  drawGraph(state.currentSubgraph);
}

function stopGraphLabelDrag() {
  state.activeGraphLabelDrag = null;
}

function formatCategoryLabel(rawCategory) {
  return (rawCategory || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeLayoutCode(rawValue) {
  const value = String(rawValue || "");
  const match = value.match(/^([A-Za-z]+)0*([1-9]\d*)$/);
  if (match) {
    return `${match[1]}${match[2]}`;
  }
  return value;
}

function deriveCurrentDxfName(schema) {
  const transportName = schema?.schema?.metadata?.transport_name || "";
  if (transportName.endsWith("__transport_track_plan")) {
    return `${transportName.replace(/__transport_track_plan$/, "")}.dxf`;
  }
  return "Current drawing";
}

function getEntityById(entityId) {
  return state.entities.find((entity) => entity.node_id === entityId) || null;
}

function getFeatureIdsForEntity(entityId) {
  return state.entityToFeatureIds[entityId] || [];
}

function getSelectedFeatureIds() {
  const selectedIds = new Set();
  state.selectedEntityIds.forEach((entityId) => {
    getFeatureIdsForEntity(entityId).forEach((featureId) => selectedIds.add(featureId));
  });
  return selectedIds;
}

function updateLayoutSelectionInfo() {
  const text = qs("layoutSelectionText");
  const toggle = qs("layoutEvidenceToggle");
  const popover = qs("layoutEvidencePopover");
  if (!state.activeDxfFile) {
    text.textContent = state.processingError || "Select a demo dataset to inspect its published layout results.";
    toggle.hidden = true;
    popover.hidden = true;
    return;
  }
  if (state.isProcessing) {
    text.textContent = "Loading the selected demo dataset...";
    toggle.hidden = true;
    popover.hidden = true;
    return;
  }
  if (state.hoveredLayoutFeatureId) {
    const hoveredEntities = state.featureToEntityIds[state.hoveredLayoutFeatureId] || [];
    if (hoveredEntities.length) {
      const labels = hoveredEntities.map((entityId) => getEntityById(entityId)?.label || entityId).join(", ");
      text.textContent = `Hovered layout element: ${labels}`;
      toggle.hidden = !hasEvidenceEntries();
      popover.hidden = !state.layoutEvidenceOpen || !hasEvidenceEntries();
      return;
    }
  }
  if (state.selectedEntityIds.length) {
    const labels = state.selectedEntityIds.map((entityId) => getEntityById(entityId)?.label || entityId).join(", ");
    text.textContent = `Selected in layout: ${labels}`;
    toggle.hidden = !hasEvidenceEntries();
    popover.hidden = !state.layoutEvidenceOpen || !hasEvidenceEntries();
    return;
  }
  text.textContent = "Hover or click an interactive layout element to inspect its linked entity.";
  toggle.hidden = !hasEvidenceEntries();
  popover.hidden = !state.layoutEvidenceOpen || !hasEvidenceEntries();
}

function setSelection(entityIds) {
  state.selectedEntityIds = [...new Set(entityIds)];
  renderEntities();
  updateLayoutSelectionInfo();
  renderLayout();
  renderEvidence();
  loadSubgraph();
}

function renderEntities() {
  const list = qs("entityList");
  if (!state.activeDxfFile) {
    list.innerHTML = `<div class="empty-state">No DXF file selected.</div>`;
    return;
  }
  const typeFilter = qs("entityType").value;
  const search = qs("entitySearch").value.trim().toLowerCase();
  const filtered = state.entities.filter((entity) => {
    if (typeFilter && entity.node_type !== typeFilter) return false;
    if (search && !entity.label.toLowerCase().includes(search) && !entity.node_id.toLowerCase().includes(search)) return false;
    return true;
  });
  list.innerHTML = "";
  filtered.forEach((entity) => {
    const item = document.createElement("button");
    item.className = `entity-item ${state.selectedEntityIds.includes(entity.node_id) ? "selected" : ""}`;
    item.innerHTML = `<div class="entity-label">${entity.label}</div><div class="entity-type">${entity.node_type}</div>`;
    item.addEventListener("click", () => setSelection([entity.node_id]));
    list.appendChild(item);
  });
}

function collectEvidenceEntries() {
  const entries = [];
  state.currentHighlights.forEach((item) => {
    (item.evidence || []).forEach((entry) => entries.push(entry.path || entry.artifact || "Evidence"));
  });
  state.selectedEntityIds.forEach((entityId) => {
    const entity = getEntityById(entityId);
    (entity?.source_refs || []).forEach((reference) => {
      entries.push(reference.path || reference.artifact || reference.role || "Evidence");
    });
  });
  return [...new Set(entries)].slice(0, 10);
}

function hasEvidenceEntries() {
  return collectEvidenceEntries().length > 0;
}

function buildLayoutIndexes() {
  const featureToEntityIds = {};
  const entityToFeatureIds = {};

  state.entities.forEach((entity) => {
    const refs = (entity.source_refs || [])
      .filter((reference) => String(reference.artifact || "").includes("transport_track_plan.geojson"))
      .map((reference) => reference.feature_id)
      .filter(Boolean);
    entityToFeatureIds[entity.node_id] = refs;
    refs.forEach((featureId) => {
      featureToEntityIds[featureId] = [...new Set([...(featureToEntityIds[featureId] || []), entity.node_id])];
    });
  });

  for (const feature of state.currentLayoutData?.features || []) {
    const kind = feature.properties?.feature_kind;
    const machineId = feature.properties?.machine_id;
    if (machineId && (kind === "machine_tight_box" || kind === "machine_clearance_box")) {
      const entityId = `Machine_${machineId}`;
      featureToEntityIds[feature.id] = [...new Set([...(featureToEntityIds[feature.id] || []), entityId])];
      entityToFeatureIds[entityId] = [...new Set([...(entityToFeatureIds[entityId] || []), feature.id])];
    }
  }

  state.featureToEntityIds = featureToEntityIds;
  state.entityToFeatureIds = entityToFeatureIds;
}

function flipLayoutY(yValue) {
  if (!state.planningBounds) {
    return yValue;
  }
  return state.planningBounds.min_y + state.planningBounds.max_y - yValue;
}

function geometryBounds(bounds) {
  if (!bounds) {
    return null;
  }
  return {
    x: bounds.min_x,
    y: flipLayoutY(bounds.max_y),
    width: bounds.max_x - bounds.min_x,
    height: bounds.max_y - bounds.min_y,
  };
}

function polygonPoints(coordinates) {
  return coordinates.map((point) => `${point[0]},${flipLayoutY(point[1])}`).join(" ");
}

function createSvgElement(tagName, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  Object.entries(attributes).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      element.setAttribute(key, String(value));
    }
  });
  return element;
}

function appendLayoutGrid(svg, bounds) {
  const minorStep = 1000;
  const majorStep = 5000;
  const gridGroup = createSvgElement("g");

  for (let xValue = bounds.min_x; xValue <= bounds.max_x + 0.5; xValue += minorStep) {
    const isMajor = Math.round((xValue - bounds.min_x) / majorStep) * majorStep === Math.round(xValue - bounds.min_x);
    gridGroup.appendChild(createSvgElement("line", {
      x1: xValue,
      y1: bounds.min_y,
      x2: xValue,
      y2: bounds.max_y,
      stroke: isMajor ? "rgba(15, 95, 133, 0.16)" : "rgba(15, 95, 133, 0.07)",
      "stroke-width": isMajor ? 120 : 70,
    }));
  }
  for (let yValue = bounds.min_y; yValue <= bounds.max_y + 0.5; yValue += minorStep) {
    const flippedY = flipLayoutY(yValue);
    const isMajor = Math.round((yValue - bounds.min_y) / majorStep) * majorStep === Math.round(yValue - bounds.min_y);
    gridGroup.appendChild(createSvgElement("line", {
      x1: bounds.min_x,
      y1: flippedY,
      x2: bounds.max_x,
      y2: flippedY,
      stroke: isMajor ? "rgba(15, 95, 133, 0.16)" : "rgba(15, 95, 133, 0.07)",
      "stroke-width": isMajor ? 120 : 70,
    }));
  }
  svg.appendChild(gridGroup);
}

function appendLayoutBorderScales(svg, bounds) {
  const scaleGroup = createSvgElement("g");
  const minorStep = 1000;
  const majorStep = 5000;
  const width = bounds.max_x - bounds.min_x;
  const height = bounds.max_y - bounds.min_y;
  const textSize = Math.min(width, height) * 0.024;
  const textStroke = Math.min(width, height) * 0.0022;
  const xMinorLength = height * 0.008;
  const xMajorLength = height * 0.014;
  const yMinorLength = width * 0.008;
  const yMajorLength = width * 0.014;

  for (let xValue = bounds.min_x; xValue <= bounds.max_x + 0.5; xValue += minorStep) {
    const offset = xValue - bounds.min_x;
    const isMajor = offset % majorStep === 0;
    const tickLength = isMajor ? xMajorLength : xMinorLength;
    scaleGroup.appendChild(createSvgElement("line", {
      x1: xValue,
      y1: bounds.max_y,
      x2: xValue,
      y2: bounds.max_y - tickLength,
      stroke: "#111827",
      "stroke-width": isMajor ? 140 : 90,
    }));
    if (isMajor && offset > 0) {
      const label = createSvgElement("text", {
        x: xValue,
        y: bounds.max_y - tickLength - height * 0.008,
        "text-anchor": "middle",
        class: "layout-scale-label",
        "font-family": "Inter, 'Segoe UI', sans-serif",
        "font-size": textSize,
        "stroke-width": textStroke,
      });
      label.textContent = String(Math.round(offset / 1000));
      scaleGroup.appendChild(label);
    }
  }

  for (let yValue = bounds.min_y; yValue <= bounds.max_y + 0.5; yValue += minorStep) {
    const offset = yValue - bounds.min_y;
    const isMajor = offset % majorStep === 0;
    const tickLength = isMajor ? yMajorLength : yMinorLength;
    const flippedY = flipLayoutY(yValue);
    scaleGroup.appendChild(createSvgElement("line", {
      x1: bounds.min_x,
      y1: flippedY,
      x2: bounds.min_x + tickLength,
      y2: flippedY,
      stroke: "#111827",
      "stroke-width": isMajor ? 140 : 90,
    }));
    if (isMajor && offset > 0) {
      const label = createSvgElement("text", {
        x: bounds.min_x + tickLength + width * 0.006,
        y: flippedY + height * 0.001,
        "text-anchor": "start",
        class: "layout-scale-label",
        "font-family": "Inter, 'Segoe UI', sans-serif",
        "font-size": textSize,
        "stroke-width": textStroke,
      });
      label.textContent = String(Math.round(offset / 1000));
      scaleGroup.appendChild(label);
    }
  }
  svg.appendChild(scaleGroup);
}

function appendLayoutLegend(svg, bounds) {
  const legendWidth = (bounds.max_x - bounds.min_x) * 0.25;
  const itemHeight = (bounds.max_y - bounds.min_y) * 0.038;
  const legendX = bounds.max_x + (bounds.max_x - bounds.min_x) * 0.025;
  const legendY = bounds.min_y + (bounds.max_y - bounds.min_y) * 0.055;
  const titleSize = Math.min(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y) * 0.023;
  const labelSize = Math.min(bounds.max_x - bounds.min_x, bounds.max_y - bounds.min_y) * 0.017;

  const group = createSvgElement("g");
  const items = [
    { type: "filled-rect", fill: "rgba(37,99,235,0.18)", stroke: "#2563eb", dash: null, labelLines: ["Tight machine box"] },
    { type: "dashed-rect", fill: "rgba(220,38,38,0.05)", stroke: "#dc2626", dash: "280 180", labelLines: ["Clearance box", "(+0.60 m)"] },
    { type: "filled-rect", fill: TRACK_CLASS_COLORS.one_way_no_pedestrian, stroke: TRACK_CLASS_COLORS.one_way_no_pedestrian, dash: null, labelLines: ["One-way, no pedestrian", "(>=2.20 m)"] },
    { type: "filled-rect", fill: TRACK_CLASS_COLORS.one_way_with_pedestrian, stroke: TRACK_CLASS_COLORS.one_way_with_pedestrian, dash: null, labelLines: ["One-way, with pedestrian", "(>=2.70 m)"] },
    { type: "filled-rect", fill: TRACK_CLASS_COLORS.two_way_no_pedestrian, stroke: TRACK_CLASS_COLORS.two_way_no_pedestrian, dash: null, labelLines: ["Two-way, no pedestrian", "(>=3.80 m)"] },
    { type: "filled-rect", fill: TRACK_CLASS_COLORS.two_way_with_pedestrian, stroke: TRACK_CLASS_COLORS.two_way_with_pedestrian, dash: null, labelLines: ["Two-way, with pedestrian", "(>=4.30 m)"] },
    { type: "dot-pattern", fill: "url(#layoutOverlapDots)", stroke: "#111827", dash: null, labelLines: ["Overlap zone"] },
  ];
  const rowHeights = items.map((item) => itemHeight * (item.labelLines.length > 1 ? 1.34 : 0.94));
  const legendHeight = itemHeight * 1.7 + rowHeights.reduce((sum, value) => sum + value, 0);

  group.appendChild(createSvgElement("rect", {
    x: legendX,
    y: legendY,
    width: legendWidth,
    height: legendHeight,
    rx: itemHeight * 0.24,
    fill: "rgba(249,253,255,0.92)",
    stroke: "rgba(191,217,229,0.95)",
    "stroke-width": 120,
  }));

  const title = createSvgElement("text", {
    x: legendX + legendWidth * 0.08,
    y: legendY + itemHeight * 0.92,
    class: "layout-canvas-legend-title",
    "font-size": titleSize,
    "font-family": "Inter, 'Segoe UI', sans-serif",
  });
  title.textContent = "Legend";
  group.appendChild(title);

  const swatchX = legendX + legendWidth * 0.08;
  const swatchW = legendWidth * 0.10;
  const swatchH = itemHeight * 0.38;
  let cursorY = legendY + itemHeight * 1.4;

  items.forEach((item, index) => {
    const rowHeight = rowHeights[index];
    const rowY = cursorY + rowHeight * 0.48;
    const swatchY = rowY - itemHeight * 0.28;

    if (item.type === "dashed-rect") {
      group.appendChild(createSvgElement("rect", {
        x: swatchX,
        y: swatchY,
        width: swatchW,
        height: swatchH,
        rx: itemHeight * 0.08,
        fill: item.fill,
        stroke: item.stroke,
        "stroke-width": 100,
        "stroke-dasharray": item.dash,
      }));
    } else {
      group.appendChild(createSvgElement("rect", {
        x: swatchX,
        y: swatchY,
        width: swatchW,
        height: swatchH,
        rx: itemHeight * 0.08,
        fill: item.fill,
        "fill-opacity": item.type === "filled-rect" && item.fill !== "url(#layoutOverlapDots)" ? 0.85 : 1,
        stroke: item.stroke,
        "stroke-width": 70,
      }));
    }

    const label = createSvgElement("text", {
      x: legendX + legendWidth * 0.24,
      y: cursorY + itemHeight * 0.10,
      class: "layout-canvas-legend",
      "font-size": labelSize,
      "font-family": "Inter, 'Segoe UI', sans-serif",
      "dominant-baseline": "hanging",
    });
    item.labelLines.forEach((lineText, lineIndex) => {
      const tspan = createSvgElement("tspan", {
        x: legendX + legendWidth * 0.24,
        dy: lineIndex === 0 ? 0 : labelSize * 1.08,
      });
      tspan.textContent = lineText;
      label.appendChild(tspan);
    });
    group.appendChild(label);
    cursorY += rowHeight;
  });

  svg.appendChild(group);
}

function getLayoutFeatureSortKey(feature) {
  const order = {
    source_reference_border: 0,
    planning_frame: 1,
    machine_area_box: 2,
    track: 3,
    track_overlap: 4,
    machine_clearance_box: 5,
    machine_tight_box: 6,
    europallet: 7,
  };
  return order[feature.properties?.feature_kind] ?? 99;
}

function getFeatureStyle(feature, baseStroke) {
  const kind = feature.properties?.feature_kind;
  if (kind === "planning_frame") {
    return { fill: "none", stroke: "#111827", strokeWidth: baseStroke * 1.2 };
  }
  if (kind === "machine_area_box") {
    return {
      fill: "rgba(15, 95, 133, 0.03)",
      stroke: "#0f5f85",
      strokeWidth: baseStroke * 0.85,
      dasharray: `${baseStroke * 1.8} ${baseStroke * 1.2}`,
    };
  }
  if (kind === "machine_tight_box") {
    return { fill: "rgba(37, 99, 235, 0.08)", stroke: "#2563eb", strokeWidth: baseStroke * 0.85 };
  }
  if (kind === "machine_clearance_box") {
    return {
      fill: "rgba(220, 38, 38, 0.03)",
      stroke: "#dc2626",
      strokeWidth: baseStroke * 0.8,
      dasharray: `${baseStroke * 1.5} ${baseStroke * 1.1}`,
    };
  }
  if (kind === "europallet") {
    return { fill: "#6b7280", stroke: "#111827", strokeWidth: baseStroke * 0.45 };
  }
  if (kind === "track") {
    const laneClass = feature.properties?.lane_class;
    const color = TRACK_CLASS_COLORS[laneClass] || "#1490ab";
    return { fill: color, fillOpacity: 0.2, stroke: color, strokeWidth: baseStroke * 0.5 };
  }
  if (kind === "track_overlap") {
    return { fill: "url(#layoutOverlapDots)", stroke: "#111827", strokeWidth: baseStroke * 0.45 };
  }
  return { fill: "none", stroke: "#94a3b8", strokeWidth: baseStroke * 0.4 };
}

function createFeatureTitle(feature, mappedEntityIds) {
  const labels = mappedEntityIds.map((entityId) => getEntityById(entityId)?.label || entityId);
  const featureKind = feature.properties?.feature_kind || "layout_feature";
  const humanKind = featureKind.replaceAll("_", " ");
  const suffix = labels.length ? ` | ${labels.join(", ")}` : "";
  return `${humanKind}${suffix}`;
}

function getLayoutLabelText(feature) {
  const kind = feature.properties?.feature_kind;
  if (kind === "machine_tight_box") {
    return normalizeLayoutCode(feature.properties?.machine_id);
  }
  if (kind === "track" || kind === "track_overlap") {
    return normalizeLayoutCode(feature.id);
  }
  return "";
}

function applyFeatureInteractions(element, featureId, mappedEntityIds) {
  if (!mappedEntityIds.length) {
    return;
  }
  element.addEventListener("mouseenter", () => {
    state.hoveredLayoutFeatureId = featureId;
    element.classList.add("hovered");
    updateLayoutSelectionInfo();
  });
  element.addEventListener("mouseleave", () => {
    if (state.hoveredLayoutFeatureId === featureId) {
      state.hoveredLayoutFeatureId = null;
    }
    element.classList.remove("hovered");
    updateLayoutSelectionInfo();
  });
  element.addEventListener("click", () => {
    setSelection(mappedEntityIds);
  });
}

function appendTransportShape(shapeLayer, labelLayer, feature, baseStroke) {
  const geometry = feature.geometry || {};
  const kind = feature.properties?.feature_kind;
  const mappedEntityIds = state.featureToEntityIds[feature.id] || [];
  const selectedFeatureIds = getSelectedFeatureIds();
  const isSelected = selectedFeatureIds.has(feature.id);
  const isHovered = state.hoveredLayoutFeatureId === feature.id;
  const style = getFeatureStyle(feature, baseStroke);

  let shapeElement = null;
  if (geometry.type === "Polygon") {
    shapeElement = createSvgElement("polygon", { points: polygonPoints(geometry.coordinates[0]) });
  } else if (geometry.type === "MultiPolygon") {
    shapeElement = createSvgElement("g");
    geometry.coordinates.forEach((polygon) => {
      shapeElement.appendChild(createSvgElement("polygon", { points: polygonPoints(polygon[0]) }));
    });
  } else if (geometry.type === "Point") {
    const [xValue, yValue] = geometry.coordinates;
    const scaleFactor = isSelected ? 2.45 : isHovered ? 2.1 : 1.8;
    const halfSize = baseStroke * scaleFactor;
    shapeElement = createSvgElement("rect", {
      x: xValue - halfSize,
      y: flipLayoutY(yValue) - halfSize,
      width: halfSize * 2,
      height: halfSize * 2,
      rx: baseStroke * 0.25,
    });
  } else {
    return;
  }

  shapeElement.setAttribute(
    "class",
    ["layout-feature", mappedEntityIds.length ? "interactive" : "", isSelected ? "selected" : "", isHovered ? "hovered" : ""]
      .filter(Boolean)
      .join(" "),
  );
  if (style.fill) {
    const fillColor = kind === "europallet" && isSelected ? "#dc2626" : style.fill;
    shapeElement.setAttribute("fill", fillColor);
  }
  if (style.fillOpacity !== undefined) {
    shapeElement.setAttribute("fill-opacity", String(style.fillOpacity));
  }
  if (style.stroke) {
    shapeElement.setAttribute("stroke", style.stroke);
  }
  if (style.strokeWidth !== undefined) {
    shapeElement.setAttribute("stroke-width", String(isSelected ? style.strokeWidth * 1.55 : style.strokeWidth));
  }
  if (style.dasharray) {
    shapeElement.setAttribute("stroke-dasharray", style.dasharray);
  }
  if (kind === "source_reference_border") {
    shapeElement.setAttribute("opacity", "0");
  }

  const title = createSvgElement("title");
  title.textContent = createFeatureTitle(feature, mappedEntityIds);
  shapeElement.appendChild(title);
  applyFeatureInteractions(shapeElement, feature.id, mappedEntityIds);
  shapeLayer.appendChild(shapeElement);

  const layoutLabelText = getLayoutLabelText(feature);
    if (layoutLabelText && geometry.type === "Polygon") {
      const ring = feature.geometry?.coordinates?.[0];
      if (Array.isArray(ring) && ring.length) {
        const xValues = ring.map((point) => point[0]);
        const yValues = ring.map((point) => point[1]);
        const labelFontSize = Math.min(
          (Math.max(...xValues) - Math.min(...xValues)) * 0.085,
          (Math.max(...yValues) - Math.min(...yValues)) * 0.17,
          baseStroke * 11,
        );
        const labelStroke = Math.max(baseStroke * 1.1, labelFontSize * 0.085);
        const label = createSvgElement("text", {
          x: (Math.min(...xValues) + Math.max(...xValues)) / 2,
          y: flipLayoutY((Math.min(...yValues) + Math.max(...yValues)) / 2),
          "text-anchor": "middle",
          class: kind === "machine_tight_box" ? "layout-legend-label" : "layout-track-label",
          "font-family": "Inter, 'Segoe UI', sans-serif",
          "font-size": Math.max(labelFontSize, baseStroke * 6),
          "stroke-width": labelStroke,
        });
        label.textContent = layoutLabelText;
        labelLayer.appendChild(label);
      }
  }
}

function renderLayoutHighlightOverlays(svg) {
  const overlayGroup = createSvgElement("g");
  state.currentHighlights.forEach((item) => {
    const mapped = getFeatureIdsForEntity(item.entity_id || "");
    if (mapped.length || !item.bounds) {
      return;
    }
    const bounds = geometryBounds(item.bounds);
    if (!bounds) {
      return;
    }
    overlayGroup.appendChild(
      createSvgElement("rect", {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        rx: Math.max(180, bounds.width * 0.01),
        fill: "rgba(247, 148, 29, 0.08)",
        stroke: "#f7941d",
        "stroke-width": Math.max(120, Math.min(bounds.width, bounds.height) * 0.03),
        class: "layout-highlight",
      }),
    );
  });
  svg.appendChild(overlayGroup);
}

function renderLayout() {
  const svg = qs("layoutCanvas");
  svg.innerHTML = "";
  if (!state.currentLayoutData || !state.planningBounds) {
    return;
  }

  const bounds = state.planningBounds;
  const width = bounds.max_x - bounds.min_x;
  const height = bounds.max_y - bounds.min_y;
  const leftMargin = width * 0.08;
  const extendedWidth = width * 1.43;
  const baseStroke = Math.max(width, height) * 0.0014;
  svg.setAttribute("viewBox", `${bounds.min_x - leftMargin} ${bounds.min_y} ${extendedWidth} ${height}`);

  const defs = createSvgElement("defs");
  const overlapPattern = createSvgElement("pattern", {
    id: "layoutOverlapDots",
    patternUnits: "userSpaceOnUse",
    width: Math.max(700, baseStroke * 6),
    height: Math.max(700, baseStroke * 6),
  });
  overlapPattern.appendChild(
    createSvgElement("circle", {
      cx: Math.max(240, baseStroke * 1.8),
      cy: Math.max(240, baseStroke * 1.8),
      r: Math.max(90, baseStroke * 0.75),
      fill: "rgba(17, 24, 39, 0.34)",
    }),
  );
  defs.appendChild(overlapPattern);
  svg.appendChild(defs);
  appendLayoutGrid(svg, bounds);

  const features = [...(state.currentLayoutData.features || [])].sort(
    (left, right) => getLayoutFeatureSortKey(left) - getLayoutFeatureSortKey(right),
  );
  const featureGroup = createSvgElement("g");
  const labelGroup = createSvgElement("g");
  features.forEach((feature) => appendTransportShape(featureGroup, labelGroup, feature, baseStroke));
  svg.appendChild(featureGroup);
  appendLayoutBorderScales(svg, bounds);
  appendLayoutLegend(svg, bounds);
  svg.appendChild(labelGroup);
  renderLayoutHighlightOverlays(svg);
}

function renderEvidence() {
  const list = qs("evidenceList");
  list.innerHTML = "";
  collectEvidenceEntries().forEach((entryText) => {
    const div = document.createElement("div");
    div.className = "entity-item evidence-item";
    div.textContent = entryText;
    list.appendChild(div);
  });
  updateLayoutSelectionInfo();
}

function drawGraph(payload) {
  const svg = qs("graphView");
  svg.innerHTML = "";
  const nodes = payload.nodes || [];
  const edges = payload.edges || [];
  if (!nodes.length) return;

  const centerX = 360;
  const centerY = 210;
  const radius = 152;
  const positions = {};
  const graphRoot = createSvgElement("g", {
    transform: `translate(${centerX} ${centerY}) scale(${state.graphScale}) translate(${-centerX} ${-centerY})`,
  });
  svg.appendChild(graphRoot);

  const edgeLayer = createSvgElement("g");
  const nodeLayer = createSvgElement("g");
  const edgeLabelLayer = createSvgElement("g");
  const nodeLabelLayer = createSvgElement("g");
  graphRoot.append(edgeLayer, nodeLayer, edgeLabelLayer, nodeLabelLayer);

  nodes.forEach((node, index) => {
    if (index === 0) {
      positions[node.node_id] = { x: centerX, y: centerY };
      return;
    }
    const angle = ((index - 1) / Math.max(nodes.length - 1, 1)) * Math.PI * 2;
    positions[node.node_id] = {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });

  edges.forEach((edge) => {
    const source = positions[edge.subject];
    const target = positions[edge.object];
    if (!source || !target) return;
    edgeLayer.appendChild(createSvgElement("line", {
      x1: source.x,
      y1: source.y,
      x2: target.x,
      y2: target.y,
      stroke: "#7f2d1f",
      "stroke-width": 2,
    }));
  });

  nodes.forEach((node) => {
    const position = positions[node.node_id];
    nodeLayer.appendChild(createSvgElement("circle", {
      cx: position.x,
      cy: position.y,
      r: node.node_type === "Machine" ? 22 : 18,
      fill: state.selectedEntityIds.includes(node.node_id) ? "#f7941d" : "#1490ab",
      stroke: "#073a5b",
      "stroke-width": 2,
    }));
  });

  edges.forEach((edge) => {
    const source = positions[edge.subject];
    const target = positions[edge.object];
    if (!source || !target) return;

    const edgeKey = getEdgeKey(edge);
    const offset = state.graphLabelOffsets[edgeKey] || { x: 0, y: 0 };
    const anchorX = (source.x + target.x) / 2;
    const anchorY = (source.y + target.y) / 2;
    const midX = anchorX + offset.x;
    const midY = anchorY + offset.y;
    const labelGroup = createSvgElement("g");
    labelGroup.setAttribute("cursor", "move");

    labelGroup.appendChild(createSvgElement("line", {
      x1: anchorX,
      y1: anchorY,
      x2: midX,
      y2: midY,
      stroke: "rgba(83, 112, 131, 0.7)",
      "stroke-width": 1,
      "stroke-dasharray": "4 3",
    }));

    const label = createSvgElement("text", {
      x: midX,
      y: midY + 2,
      fill: "#537083",
      "font-size": 10,
      "font-weight": 600,
      "text-anchor": "middle",
    });
    label.textContent = edge.predicate;
    labelGroup.appendChild(label);
    edgeLabelLayer.appendChild(labelGroup);

    const textBounds = label.getBBox();
    labelGroup.insertBefore(createSvgElement("rect", {
      x: textBounds.x - 8,
      y: textBounds.y - 4,
      width: Math.max(44, textBounds.width + 16),
      height: textBounds.height + 8,
      rx: 9,
      fill: "rgba(249,253,255,0.96)",
      stroke: "rgba(191,217,229,0.92)",
      "stroke-width": 1,
    }), label);
    labelGroup.addEventListener("pointerdown", (event) => startGraphLabelDrag(event, edgeKey));
  });

  nodes.forEach((node) => {
    const position = positions[node.node_id];
    const nodeLabelKey = getNodeLabelKey(node);
    const offset = state.graphLabelOffsets[nodeLabelKey] || { x: 0, y: 0 };
    const labelGroup = createSvgElement("g");
    labelGroup.setAttribute("cursor", "move");
    const label = createSvgElement("text", {
      x: position.x + offset.x,
      y: position.y + (node.node_type === "Machine" ? 38 : 34) + offset.y,
      fill: "#073a5b",
      "font-size": 11,
      "font-weight": 600,
      "text-anchor": "middle",
    });
    label.textContent = node.label;
    labelGroup.appendChild(label);
    labelGroup.addEventListener("pointerdown", (event) => startGraphLabelDrag(event, nodeLabelKey));
    nodeLabelLayer.appendChild(labelGroup);
  });
}

function renderAnswerMeta(payload) {
  qs("answerText").textContent = payload.answer_text || "No matched answer is available.";
}

async function loadEntities() {
  const payload = await fetchJson("/api/entities");
  state.entities = payload.entities || [];
  buildLayoutIndexes();
  renderEntities();
  renderLayout();
  renderEvidence();
}

async function loadLayoutData() {
  if (!state.transportGeoJson) {
    state.currentLayoutData = null;
    renderLayout();
    return;
  }
  state.currentLayoutData = await fetchJson(state.transportGeoJson);
  buildLayoutIndexes();
  renderLayout();
}

async function loadSubgraph() {
  if (!state.selectedEntityIds.length) {
    state.currentSubgraph = { nodes: [], edges: [] };
    drawGraph(state.currentSubgraph);
    return;
  }
  const payload = await fetchJson(`/api/subgraph?node_id=${encodeURIComponent(state.selectedEntityIds[0])}`);
  state.currentSubgraph = payload;
  drawGraph(state.currentSubgraph);
}

async function askQuestion(question) {
  if (state.isProcessing) {
    return;
  }
  const payload = await fetchJson("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      selected_entity_ids: state.selectedEntityIds,
      conversation_history: state.conversationHistory,
    }),
  });

  state.conversationHistory.push({ role: "user", content: question });
  state.conversationHistory.push({ role: "assistant", content: payload.answer_text });
  state.conversationHistory = state.conversationHistory.slice(-8);

  state.currentHighlights = payload.highlights || [];
  if (state.activeDxfFile && payload.referenced_entities?.length) {
    setSelection(payload.referenced_entities);
  } else {
    renderLayout();
    renderEvidence();
  }
  renderAnswerMeta(payload);
}

async function loadQuestionBank() {
  const container = qs("questionBank");
  if (state.questionBankOpen) {
    state.questionBankOpen = false;
    container.innerHTML = "";
    return;
  }
  const payload = await fetchJson("/api/question-bank");
  container.innerHTML = "";
  payload.categories.forEach((category) => {
    const section = document.createElement("section");
    section.className = "question-category";
    const title = document.createElement("div");
    title.className = "question-category-title";
    title.textContent = formatCategoryLabel(category.category);
    section.appendChild(title);
    const chipRow = document.createElement("div");
    chipRow.className = "question-chip-row";
    category.questions.forEach((entry) => {
      const chip = document.createElement("button");
      chip.className = "question-chip";
      chip.textContent = entry.question;
      chip.addEventListener("click", async () => {
        qs("questionInput").value = entry.question;
        await askQuestion(entry.question);
      });
      chipRow.appendChild(chip);
    });
    section.appendChild(chipRow);
    container.appendChild(section);
  });
  state.questionBankOpen = true;
}

function resetWorkspace() {
  state.entities = [];
  state.selectedEntityIds = [];
  state.transportGeoJson = null;
  state.planningBounds = null;
  state.currentHighlights = [];
  state.currentLayoutData = null;
  state.hoveredLayoutFeatureId = null;
  state.layoutEvidenceOpen = false;
  state.questionBankOpen = false;
  state.featureToEntityIds = {};
  state.entityToFeatureIds = {};
  state.conversationHistory = [];
  state.currentSubgraph = { nodes: [], edges: [] };
  qs("schemaSummary").textContent = "No drawing loaded";
  qs("answerText").textContent = "Select a question from the question bank to display its stored answer.";
  qs("questionBank").innerHTML = "";
  renderEntities();
  renderLayout();
  drawGraph(state.currentSubgraph);
  renderEvidence();
}

async function loadDxfFileOptions() {
  const select = qs("dxfFileSelect");
  const payload = await fetchJson("/api/dxf-files");
  select.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
    placeholder.textContent = "Select a demo dataset...";
  placeholder.selected = true;
  select.appendChild(placeholder);
  (payload.files || []).forEach((file) => {
    const option = document.createElement("option");
    option.value = file.name;
    option.textContent = file.name;
    select.appendChild(option);
  });
}

async function processSelectedDxf(fileName) {
  if (!fileName) {
    state.activeDxfFile = null;
    state.processingError = "";
    resetWorkspace();
    updateLayoutSelectionInfo();
    return;
  }
  state.activeDxfFile = fileName;
  state.isProcessing = true;
  state.processingError = "";
  resetWorkspace();
  state.activeDxfFile = fileName;
  updateLayoutSelectionInfo();
  const select = qs("dxfFileSelect");
  select.disabled = true;
  qs("statusText").textContent = "Loading Demo";
  try {
    const result = await fetchJson("/api/process-dxf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_name: fileName }),
    });
    state.transportGeoJson = result.artifacts?.transport_geojson || null;
    const schema = await fetchJson("/api/schema");
    qs("schemaSummary").textContent = `${schema.schema.entity_types.length} entity types / ${schema.schema.relation_types.length} relations`;
    state.planningBounds = schema.schema.metadata.planning_frame_bounds;
    await Promise.all([loadLayoutData(), loadEntities()]);
    updateLayoutSelectionInfo();
  } catch (error) {
    state.activeDxfFile = null;
    state.processingError = `Processing failed: ${error.message}`;
    resetWorkspace();
    console.error(error);
  } finally {
    state.isProcessing = false;
    select.disabled = false;
    qs("statusText").textContent = "Static QA Ready";
    qs("dxfFileSelect").value = state.activeDxfFile || "";
    updateLayoutSelectionInfo();
  }
}

async function boot() {
  qs("graphView").addEventListener("pointermove", updateGraphLabelDrag);
  qs("graphView").addEventListener("pointerup", stopGraphLabelDrag);
  qs("graphView").addEventListener("pointerleave", stopGraphLabelDrag);
  qs("entityType").addEventListener("change", renderEntities);
  qs("entitySearch").addEventListener("input", renderEntities);
  qs("dxfFileSelect").addEventListener("change", (event) => {
    processSelectedDxf(event.target.value);
  });
  qs("layoutEvidenceToggle").addEventListener("click", (event) => {
    event.stopPropagation();
    if (!hasEvidenceEntries()) {
      return;
    }
    state.layoutEvidenceOpen = !state.layoutEvidenceOpen;
    updateLayoutSelectionInfo();
  });
  document.addEventListener("click", (event) => {
    const container = qs("layoutSelectionInfo");
    if (!container.contains(event.target)) {
      state.layoutEvidenceOpen = false;
      updateLayoutSelectionInfo();
    }
  });
  qs("loadQuestionsButton").addEventListener("click", loadQuestionBank);
  qs("graphZoomIn").addEventListener("click", () => {
    state.graphScale = Math.min(1.85, Number((state.graphScale + 0.15).toFixed(2)));
    drawGraph(state.currentSubgraph);
  });
  qs("graphZoomOut").addEventListener("click", () => {
    state.graphScale = Math.max(0.7, Number((state.graphScale - 0.15).toFixed(2)));
    drawGraph(state.currentSubgraph);
  });
  qs("graphZoomReset").addEventListener("click", () => {
    state.graphScale = 1;
    drawGraph(state.currentSubgraph);
  });
  qs("chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const question = qs("questionInput").value.trim();
    if (!question) return;
    askQuestion(question);
    qs("questionInput").value = "";
  });

  const health = await fetchJson("/api/health");
  const status = qs("ollamaStatus");
  const statusIcon = qs("statusIcon");
  const statusText = qs("statusText");
  if (health.cached_answer_count > 0) {
    status.classList.add("online");
    status.classList.remove("offline");
    statusIcon.textContent = "OK";
    statusText.textContent = "Static QA Ready";
  } else {
    status.classList.add("offline");
    status.classList.remove("online");
    statusIcon.textContent = "✕";
    statusText.textContent = "Static QA Unavailable";
  }

  await loadDxfFileOptions();
  await processSelectedDxf(DEMO_DRAWING);
}

boot().catch((error) => {
  qs("ollamaStatus").classList.add("offline");
  qs("statusIcon").textContent = "✕";
  qs("statusText").textContent = "Ollama Unknown";
  console.error(error);
});
