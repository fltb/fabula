/**
 * Read-only LogicFlow canvas wrapped in Solid's DOM lifecycle.
 *
 * The canvas is a projection surface only: it is created in `isSilentMode`,
 * every editing affordance (drag, adjust, rotate, text edit, keyboard
 * shortcuts, delete/clone guards) is disabled, and the data it renders comes
 * exclusively from the frozen `GraphCanvasModelV1` produced by
 * `graph-view-model.ts`. Node selection is the only interaction surfaced to
 * the caller; fit/zoom/reset are exposed through the controls handle. The
 * Host never receives layout coordinates or any write.
 */

import LogicFlow from '@logicflow/core';
import { MiniMap } from '@logicflow/extension';
import { createEffect, onCleanup, onMount } from 'solid-js';
import { type GraphCanvasModelV1, toLogicFlowData } from './graph-view-model';

import '@logicflow/core/dist/style/index.css';
import '@logicflow/extension/lib/style/index.css';

/** Register the minimap extension once; instances opt in per canvas. */
LogicFlow.use(MiniMap);

/** Viewport navigation controls; the only surface a caller may drive. */
export interface LogicFlowGraphControls {
  readonly fitView: () => void;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly resetZoom: () => void;
}

export interface LogicFlowGraphProps {
  /** Frozen deterministic canvas model for exactly one domain. */
  readonly model: GraphCanvasModelV1;
  /** Accessible name of this canvas, e.g. "Story graph canvas". */
  readonly label: string;
  /** Called with the canonical node id when the author selects a node. */
  readonly onNodeSelect?: (nodeId: string) => void;
  /** Registers viewport controls on mount and unregisters on unmount. */
  readonly onControls?: (controls: LogicFlowGraphControls | null) => void;
}

interface NodeClickEvent {
  readonly data?: { readonly id?: string };
}

interface LogicFlowExtensionView {
  readonly extension?: {
    readonly miniMap?: {
      show(): void;
    };
  };
}

function showMiniMap(instance: LogicFlow): void {
  // The extension API exists after `LogicFlow.use(MiniMap)` but is omitted from
  // this release's base instance declaration.
  const extensionView = instance as unknown as LogicFlowExtensionView;
  extensionView.extension?.miniMap?.show();
}

/** @logicflow/core has no instance destroy; teardown is listener + DOM. */
export function LogicFlowGraph(props: LogicFlowGraphProps) {
  let container: HTMLElement | undefined;
  let lf: LogicFlow | undefined;
  let handleNodeClick: ((event: NodeClickEvent) => void) | undefined;
  let handleRendered: (() => void) | undefined;

  onMount(() => {
    const element = container;
    if (!element) return;
    lf = new LogicFlow({
      container: element,
      // Read-only projection: every editing path is off.
      isSilentMode: true,
      adjustEdge: false,
      adjustEdgeStartAndEnd: false,
      adjustNodePosition: false,
      allowRotation: false,
      hideAnchors: true,
      hoverOutline: false,
      nodeTextEdit: false,
      edgeTextEdit: false,
      textEdit: false,
      snapline: false,
      keyboard: { enabled: false },
      // Viewport navigation stays enabled (zoom, pan); graph data never moves.
      stopZoomGraph: false,
      stopScrollGraph: false,
      stopMoveGraph: false,
      edgeType: 'bezier',
      grid: true,
      background: false,
      guards: {
        beforeDelete: () => false,
        beforeClone: () => false,
      },
    });
    handleNodeClick = (event) => {
      const id = event.data?.id;
      if (typeof id === 'string' && id.length > 0) props.onNodeSelect?.(id);
    };
    handleRendered = () => {
      lf?.fitView();
    };
    lf.on('node:click', handleNodeClick);
    lf.on('graph:rendered', handleRendered);
    props.onControls?.({
      fitView: () => lf?.fitView(),
      zoomIn: () => lf?.zoom(2),
      zoomOut: () => lf?.zoom(0.5),
      resetZoom: () => lf?.resetZoom(),
    });
  });

  // Renders the current model; re-renders when a route refetch supplies a new
  // frozen projection. Runs after the mount callback created the instance.
  createEffect(() => {
    const instance = lf;
    if (!instance) return;
    instance.render(toLogicFlowData(props.model));
    instance.fitView();
    if (props.model.nodes.length > 0) {
      showMiniMap(instance);
    }
  });

  onCleanup(() => {
    const instance = lf;
    if (instance) {
      if (handleNodeClick) instance.off('node:click', handleNodeClick);
      if (handleRendered) instance.off('graph:rendered', handleRendered);
    }
    // The canvas DOM belongs to LogicFlow; drop it with the wrapper. Solid
    // removes the container itself on unmount.
    container?.replaceChildren();
    lf = undefined;
    handleNodeClick = undefined;
    handleRendered = undefined;
    props.onControls?.(null);
  });

  return (
    <section
      ref={container}
      class="graph-canvas"
      aria-label={props.label}
      data-domain={props.model.domain}
    />
  );
}
