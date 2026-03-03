figma.showUI(__html__, { width: 520, height: 780 });

var lockedFrameId = null;

function post(type, data) {
  var msg = { type: type };
  if (data) {
    for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) msg[k] = data[k];
  }
  figma.ui.postMessage(msg);
}

function getBounds(node) {
  if (!node || !node.absoluteBoundingBox) return null;
  return node.absoluteBoundingBox;
}

function isValidFrameNode(node) {
  if (!node) return false;
  var validTypes = ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION", "GROUP", "INSTANCE"];
  if (validTypes.indexOf(node.type) === -1) return false;
  return !!getBounds(node);
}

function framePayload(node) {
  var b = getBounds(node);
  return {
    id: node.id,
    name: node.name,
    width: Math.round(b.width),
    height: Math.round(b.height)
  };
}

function getSelectedFrame() {
  var selection = figma.currentPage.selection;
  if (!selection || selection.length === 0) return { frame: null, error: "Select a frame." };
  if (selection.length > 1) return { frame: null, error: "Select only one frame." };

  var node = selection[0];
  if (!isValidFrameNode(node)) return { frame: null, error: node.name + " is a " + node.type + ", not a frame." };
  return { frame: node, error: null };
}

function resolveActiveFrame() {
  if (lockedFrameId) {
    var lockedNode = figma.getNodeById(lockedFrameId);
    if (isValidFrameNode(lockedNode)) return lockedNode;
    lockedFrameId = null;
  }

  var sel = getSelectedFrame();
  return sel.frame || null;
}

function sendSelection() {
  var node = resolveActiveFrame();
  if (node) {
    post("update", { frame: framePayload(node), error: null, locked: !!lockedFrameId });
    return;
  }

  var sel = getSelectedFrame();
  post("update", {
    frame: null,
    error: sel.error,
    locked: false
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toInt(n, fallback) {
  var parsed = Number(n);
  if (Number.isFinite(parsed)) return Math.round(parsed);
  return fallback;
}

function pushUniqueBoundary(list, y, minY, maxY) {
  var cy = clamp(Math.round(y), minY, maxY);
  for (var i = 0; i < list.length; i++) {
    if (Math.abs(list[i] - cy) <= 2) return;
  }
  list.push(cy);
}

function fallbackFixedSlices(frameWidth, bodyTop, bodyBottom, targetHeight) {
  var slices = [];
  var y = bodyTop;
  while (y + targetHeight <= bodyBottom) {
    slices.push({ rect: { x: 0, y: y, width: frameWidth, height: targetHeight }, url: "", alt: "", label: "" });
    y += targetHeight;
  }
  if (y < bodyBottom) {
    var rem = bodyBottom - y;
    if (slices.length === 0) {
      slices.push({ rect: { x: 0, y: bodyTop, width: frameWidth, height: bodyBottom - bodyTop }, url: "", alt: "", label: "" });
    } else {
      slices[slices.length - 1].rect.height += rem;
    }
  }
  return slices;
}

function collectNodeBlocks(frameNode, frameBounds, bodyTop, bodyBottom, frameWidth, targetHeight) {
  var blocks = [];
  var edges = [];
  var queue = [];
  var maxNodes = 5000;

  if ("children" in frameNode && Array.isArray(frameNode.children)) {
    for (var i = 0; i < frameNode.children.length; i++) queue.push(frameNode.children[i]);
  }

  while (queue.length && blocks.length < maxNodes) {
    var node = queue.shift();
    if (!node || node.visible === false) continue;

    if ("children" in node && Array.isArray(node.children)) {
      for (var j = 0; j < node.children.length; j++) queue.push(node.children[j]);
    }

    var b = getBounds(node);
    if (!b) continue;

    var relX = Math.round(b.x - frameBounds.x);
    var relY = Math.round(b.y - frameBounds.y);
    var relW = Math.round(b.width);
    var relH = Math.round(b.height);
    if (relW <= 0 || relH <= 0) continue;

    var start = clamp(relY, bodyTop, bodyBottom);
    var end = clamp(relY + relH, bodyTop, bodyBottom);
    if (end <= start) continue;

    var widthRatio = relW / frameWidth;
    var areaRatio = (relW * relH) / (frameWidth * Math.max(1, targetHeight));
    var typeBoost = 1;
    if (node.type === "TEXT") typeBoost = 0.8;
    if (node.type === "RECTANGLE" || node.type === "FRAME" || node.type === "INSTANCE" || node.type === "COMPONENT") typeBoost = 1.1;
    var weight = Math.max(0.1, Math.min(3.5, (0.35 + areaRatio) * typeBoost));

    blocks.push({ start: start, end: end, weight: weight });

    if (widthRatio >= 0.6 && relH >= 16) {
      edges.push(start);
      edges.push(end);
    }
  }

  return { blocks: blocks, edges: edges };
}

function buildBoundariesByDensity(blocks, bodyTop, bodyBottom, targetHeight) {
  var bodyHeight = bodyBottom - bodyTop;
  var step = Math.max(2, Math.round(targetHeight / 40));
  var bins = Math.max(10, Math.ceil(bodyHeight / step));
  var density = [];
  for (var i = 0; i < bins; i++) density.push(0);

  for (var b = 0; b < blocks.length; b++) {
    var blk = blocks[b];
    var bs = clamp(Math.floor((blk.start - bodyTop) / step), 0, bins - 1);
    var be = clamp(Math.ceil((blk.end - bodyTop) / step), 0, bins - 1);
    for (var k = bs; k <= be; k++) density[k] += blk.weight;
  }

  var boundaries = [bodyTop, bodyBottom];
  var lowThreshold = 0.45;
  var minGapBins = Math.max(2, Math.round((targetHeight * 0.08) / step));
  var runStart = -1;
  for (var i2 = 0; i2 < bins; i2++) {
    var isLow = density[i2] <= lowThreshold;
    if (isLow && runStart < 0) runStart = i2;
    if ((!isLow || i2 === bins - 1) && runStart >= 0) {
      var runEnd = isLow && i2 === bins - 1 ? i2 : i2 - 1;
      if (runEnd - runStart + 1 >= minGapBins) {
        var mid = bodyTop + Math.round(((runStart + runEnd + 1) / 2) * step);
        pushUniqueBoundary(boundaries, mid, bodyTop, bodyBottom);
      }
      runStart = -1;
    }
  }

  return boundaries;
}

function intervalsFromBoundaries(boundaries, bodyTop, bodyBottom, targetHeight, frameWidth) {
  boundaries.sort(function(a, b) { return a - b; });

  var minSeg = Math.max(80, Math.round(targetHeight * 0.35));
  var compact = [boundaries[0]];
  for (var i = 1; i < boundaries.length; i++) {
    if (boundaries[i] - compact[compact.length - 1] >= minSeg) compact.push(boundaries[i]);
  }
  if (compact[compact.length - 1] !== bodyBottom) compact.push(bodyBottom);

  var raw = [];
  for (var j = 0; j < compact.length - 1; j++) {
    var s = compact[j], e = compact[j + 1];
    if (e - s >= minSeg) raw.push({ start: s, end: e });
  }
  if (!raw.length) return fallbackFixedSlices(frameWidth, bodyTop, bodyBottom, targetHeight);

  var slices = [];
  var maxSeg = Math.max(targetHeight + 60, Math.round(targetHeight * 1.55));
  for (var k = 0; k < raw.length; k++) {
    var seg = raw[k];
    var segH = seg.end - seg.start;
    if (segH <= maxSeg) {
      slices.push({ rect: { x: 0, y: seg.start, width: frameWidth, height: segH }, url: "", alt: "", label: "" });
      continue;
    }

    var parts = Math.max(2, Math.round(segH / targetHeight));
    var partH = Math.round(segH / parts);
    var y = seg.start;
    for (var p = 0; p < parts; p++) {
      var nextY = p === parts - 1 ? seg.end : y + partH;
      slices.push({ rect: { x: 0, y: y, width: frameWidth, height: nextY - y }, url: "", alt: "", label: "" });
      y = nextY;
    }
  }

  // Force contiguous non-overlapping coverage from bodyTop..bodyBottom.
  if (!slices.length) return fallbackFixedSlices(frameWidth, bodyTop, bodyBottom, targetHeight);
  slices.sort(function(a, b) { return a.rect.y - b.rect.y; });
  slices[0].rect.y = bodyTop;
  for (var x = 0; x < slices.length - 1; x++) {
    var cur = slices[x].rect;
    var next = slices[x + 1].rect;
    var curBottom = cur.y + cur.height;
    if (next.y !== curBottom) next.y = curBottom;
    if (next.y < curBottom) next.y = curBottom;
  }
  var last = slices[slices.length - 1].rect;
  last.height = Math.max(minSeg, bodyBottom - last.y);
  if (last.y + last.height > bodyBottom) last.height = bodyBottom - last.y;
  if (last.height < 1) {
    slices.pop();
  }

  return slices;
}

function suggestSlices(frameNode, opts) {
  var frameBounds = getBounds(frameNode);
  if (!frameBounds) return [];

  var frameWidth = Math.round(frameNode.width);
  var frameHeight = Math.round(frameNode.height);

  var headerHeight = clamp(toInt(opts && opts.headerHeight, 0), 0, frameHeight);
  var footerHeight = clamp(toInt(opts && opts.footerHeight, 0), 0, frameHeight);
  var rawHeight = toInt(opts && opts.maxSliceHeight, 300);
  var fixedSliceHeight = rawHeight > 0 ? rawHeight : 300;

  var bodyTop = headerHeight;
  var bodyBottom = frameHeight - footerHeight;
  if (bodyBottom <= bodyTop) return [];

  var collected = collectNodeBlocks(frameNode, frameBounds, bodyTop, bodyBottom, frameWidth, fixedSliceHeight);
  if (!collected.blocks.length) {
    return fallbackFixedSlices(frameWidth, bodyTop, bodyBottom, fixedSliceHeight);
  }

  var boundaries = buildBoundariesByDensity(collected.blocks, bodyTop, bodyBottom, fixedSliceHeight);
  for (var i = 0; i < collected.edges.length; i++) {
    pushUniqueBoundary(boundaries, collected.edges[i], bodyTop, bodyBottom);
  }

  return intervalsFromBoundaries(boundaries, bodyTop, bodyBottom, fixedSliceHeight, frameWidth);
}

figma.ui.onmessage = function(msg) {
  if (!msg || !msg.type) return;

  if (msg.type === "refresh") {
    sendSelection();
    return;
  }

  if (msg.type === "lock-frame") {
    var sel = getSelectedFrame();
    if (!sel.frame) {
      post("lock-result", { ok: false, error: sel.error });
      return;
    }
    lockedFrameId = sel.frame.id;
    sendSelection();
    post("lock-result", { ok: true, locked: true });
    return;
  }

  if (msg.type === "unlock-frame") {
    lockedFrameId = null;
    sendSelection();
    post("lock-result", { ok: true, locked: false });
    return;
  }

  if (msg.type === "preview") {
    var previewNode = resolveActiveFrame();
    if (!previewNode) {
      post("preview-error", { message: "No frame selected" });
      return;
    }

    previewNode.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } })
      .then(function(bytes) {
        post("preview-done", {
          base64: figma.base64Encode(bytes),
          logicalWidth: Math.round(previewNode.width),
          logicalHeight: Math.round(previewNode.height),
          name: previewNode.name
        });
      })
      .catch(function(err) {
        post("preview-error", { message: err.message || "Preview export failed" });
      });
    return;
  }

  if (msg.type === "auto-suggest") {
    var activeNode = resolveActiveFrame();
    if (!activeNode) {
      post("suggest-error", { message: "No frame selected" });
      return;
    }

    try {
      var suggestions = suggestSlices(activeNode, {
        headerHeight: msg.headerHeight,
        footerHeight: msg.footerHeight,
        maxSliceHeight: msg.maxSliceHeight
      });
      post("suggest-done", { slices: suggestions, count: suggestions.length });
    } catch (err) {
      post("suggest-error", { message: err.message || "Slice suggestion failed" });
    }
    return;
  }

  if (msg.type === "export") {
    var node = resolveActiveFrame();
    if (!node) {
      post("export-error", { message: "No frame selected" });
      return;
    }

    var exportScale = 2;
    node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: exportScale } })
      .then(function(bytes) {
        post("export-done", {
          base64: figma.base64Encode(bytes),
          logicalWidth: Math.round(node.width),
          logicalHeight: Math.round(node.height),
          pixelRatio: exportScale,
          exportWidth: Math.round(node.width * exportScale),
          exportHeight: Math.round(node.height * exportScale),
          name: node.name,
          manualSlices: Array.isArray(msg.manualSlices) ? msg.manualSlices : []
        });
      })
      .catch(function(err) {
        post("export-error", { message: err.message || "Export failed" });
      });
    return;
  }

  if (msg.type === "notify") {
    figma.notify(msg.message || "Done");
  }
};

figma.on("selectionchange", function() {
  sendSelection();
});

sendSelection();
