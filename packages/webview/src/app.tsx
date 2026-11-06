import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import dagre from '@dagrejs/dagre';
import type { FromExtensionToWebview, GraphNodeDTO } from '@code_modules/core';
import { onMessage, send } from './bridge';
import { MonacoNodeEditor } from './editor';

interface AppData {
  nodeMap: Record<string, GraphNodeDTO>;
  edgeList: Array<{ from: string; to: string; type: string }>;
  layers: string[];
  depth: number;
  layerFilter: string[];
  query: string;
  status: string;
  editing: string | null;
  editingContent: string;
  agentLog: string[];
}

const KIND_ICONS: Record<string, string> = {
  function: 'λ',
  class: 'C',
  method: 'm',
  component: '</>',
  route: '→',
  const: '◆',
  config: '⚙',
  type: 'T',
};

function layout(nodes: GraphNodeDTO[], edges: Array<{ from: string; to: string }>): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: 260, height: 100 });
  for (const e of edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to)) g.setEdge(e.from, e.to);
  }
  dagre.layout(g);
  const pos = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    if (p) pos.set(n.id, { x: p.x - 130, y: p.y - 50 });
  }
  return pos;
}

interface CardData {
  dto: GraphNodeDTO;
  editing: boolean;
  editingContent: string;
  agentInstruction: string;
  [k: string]: unknown;
}

function NodeCard({ data }: NodeProps) {
  const card = data as unknown as CardData;
  const n = card.dto;
  const [agentInstruction, setAgentInstruction] = useState('');
  const lang = n.file.endsWith('.tsx') ? 'tsx' : n.file.endsWith('.ts') ? 'typescript' : n.file.endsWith('.js') ? 'javascript' : 'typescript';
  return (
    <div className={`nodecard kind-${n.kind} ${n.locked ? 'locked' : ''}`} data-node-id={n.id}>
      <div className="nodecard-head">
        <span className="kind-chip" title={n.kind}>{KIND_ICONS[n.kind] ?? '?'}</span>
        <span className="nodecard-title" title={n.id}>{n.label}</span>
        {n.stale && <span className="stale-badge" title="metadata stale: regenerate with /init">stale</span>}
        <button
          className={`lock-badge ${n.locked ? 'locked' : ''}`}
          title={n.locked ? `Locked: ${n.lockReason}. Click ONCE to unlock (explicit human action).` : 'Lock this node: the agent will be physically unable to modify it.'}
          onClick={(ev) => {
            ev.stopPropagation();
            if (n.locked) {
              const ok = window.confirm(`Unlock ${n.id} for agent edits?\n(You can always re-lock it.)`);
              if (ok) send({ type: 'toggleLock', id: n.id });
            } else {
              send({ type: 'toggleLock', id: n.id });
            }
          }}
        >
          {n.locked ? '🔒' : '🔓'}
        </button>
      </div>
      <div className="nodecard-file">
        {n.file}:{n.startLine}
        {n.tags.length > 0 && <span className="tags"> {n.tags.map((t) => `#${t}`).join(' ')}</span>}
      </div>
      <div className={`nodecard-summary ${n.summary ? '' : 'muted'}`}>{n.summary || n.signature}</div>
      <div className="nodecard-actions">
        {card.editing ? (
          <>
            <span className="editing-hint">editing…</span>
            <button onClick={() => send({ type: 'cancelEdit', id: n.id })}>cancel</button>
          </>
        ) : (
          <>
            <button onClick={() => send({ type: 'startEdit', id: n.id })}>edit</button>
            <button onClick={() => send({ type: 'revealNode', id: n.id })}>open</button>
            <button onClick={() => send({ type: 'expandNode', id: n.id, depth: 1 })}>+deps</button>
          </>
        )}
      </div>
      {!card.editing && (
        <div className="nodecard-agent">
          <input
            placeholder="Ask the agent about this node…"
            value={agentInstruction}
            onChange={(e) => setAgentInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && agentInstruction.trim()) {
                send({ type: 'agentRun', rootIds: [n.id], instruction: agentInstruction.trim() });
                setAgentInstruction('');
              }
            }}
          />
        </div>
      )}
      {card.editing && (
        <MonacoNodeEditor
          initial={card.editingContent}
          language={lang}
          onSave={(code) => send({ type: 'saveEdit', id: n.id, content: code })}
        />
      )}
    </div>
  );
}

export function App() {
  const [data, setData] = useState<AppData>({
    nodeMap: {},
    edgeList: [],
    layers: [],
    depth: 2,
    layerFilter: [],
    query: '',
    status: 'connecting…',
    editing: null,
    editingContent: '',
    agentLog: [],
  });

  useEffect(() => {
    const off = onMessage((msg: FromExtensionToWebview) => {
      switch (msg.type) {
        case 'graphUpdated': {
          const map: Record<string, GraphNodeDTO> = {};
          for (const n of msg.nodes) map[n.id] = n;
          setData((d) => ({
            ...d,
            nodeMap: map,
            edgeList: msg.edges.map((e) => ({ from: e.from, to: e.to, type: e.type as string })),
            layers: msg.layers,
            status: msg.nodes.length ? `${msg.nodes.length} nodes` : 'no nodes — search or /init',
          }));
          break;
        }
        case 'nodeContent':
          setData((d) => ({ ...d, editing: msg.id, editingContent: msg.content }));
          break;
        case 'agentProgress':
          setData((d) => ({ ...d, status: msg.message, agentLog: [...d.agentLog, msg.message].slice(-10) }));
          break;
        case 'agentDone':
          setData((d) => ({ ...d, status: 'agent done', agentLog: [...d.agentLog, '✦ ' + msg.reply.split('\n')[0]].slice(-10) }));
          break;
        case 'error':
          setData((d) => ({ ...d, status: '⚠ ' + msg.message, agentLog: [...d.agentLog, '⚠ ' + msg.message].slice(-10) }));
          break;
        default:
          break;
      }
    });
    send({ type: 'ready' });
    return off;
  }, []);

  const doSearch = useCallback(
    (query: string, depth: number, layerFilter?: string[]) => {
      send({ type: 'search', query, depth, layerFilter });
    },
    []
  );

  const toggleLayer = (l: string) => {
    const next = data.layerFilter.includes(l) ? data.layerFilter.filter((x) => x !== l) : [...data.layerFilter, l];
    setData((d) => ({ ...d, layerFilter: next }));
    doSearch(data.query, data.depth, next.length ? next : undefined);
  };

  const flowNodes = useMemo(
    () => {
      const list = Object.values(data.nodeMap);
      const pos = layout(list, data.edgeList);
      return list.map((n): Node => ({
        id: n.id,
        data: {
          dto: n,
          editing: data.editing === n.id,
          editingContent: data.editing === n.id ? data.editingContent : '',
          agentInstruction: '',
        },
        position: pos.get(n.id) ?? { x: 0, y: 0 },
        type: 'nodeCard',
        targetPosition: Position.Top,
        sourcePosition: Position.Bottom,
      }));
    },
    [data.nodeMap, data.edgeList, data.editing, data.editingContent]
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      data.edgeList
        .filter((e) => data.nodeMap[e.from] && data.nodeMap[e.to])
        .map((e) => ({
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          label: e.type,
          animated: e.type === 'calls',
          style: { stroke: e.type === 'route' ? '#4a9eff' : '#787878' },
        })),
    [data.edgeList, data.nodeMap]
  );

  const nodeTypes = useMemo(() => ({ nodeCard: NodeCard }) as never, []);
  const manyNodes = flowNodes.length > 120;

  return (
    <div className="app">
      <div className="topbar">
        <input
          className="search"
          placeholder="Search a feature: user settings…"
          value={data.query}
          onChange={(e) => setData((d) => ({ ...d, query: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') doSearch(data.query, data.depth, data.layerFilter.length ? data.layerFilter : undefined);
          }}
        />
        <label className="depth">
          depth
          <input
            type="number"
            min={0}
            max={4}
            value={data.depth}
            onChange={(e) => {
              const v = Math.max(0, Math.min(4, Number(e.target.value)));
              setData((d) => ({ ...d, depth: v }));
              if (data.query) doSearch(data.query, v, data.layerFilter.length ? data.layerFilter : undefined);
            }}
          />
        </label>
        <button className="primary" onClick={() => doSearch(data.query, data.depth, data.layerFilter.length ? data.layerFilter : undefined)}>
          Search
        </button>
        <button onClick={() => send({ type: 'refresh' })}>Overview</button>
        <button onClick={() => send({ type: 'initScan' })}>/init scan</button>
        <div className="layers">
          {data.layers.map((l) => (
            <button key={l} className={`layer ${data.layerFilter.includes(l) ? 'on' : ''}`} onClick={() => toggleLayer(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.1}
          onlyRenderVisibleElements={manyNodes}
        >
          <Background />
          <Controls />
          {!manyNodes && <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.3)" />}
        </ReactFlow>
        {flowNodes.length === 0 && (
          <div className="empty">
            <p>Search for a feature (“user settings”), or run <b>/init scan</b> to index the workspace.</p>
          </div>
        )}
      </div>
      <div className="agent-dock">
        <div className="agent-title">agent</div>
        {data.agentLog.length === 0 && <div className="agent-line muted">no agent activity yet</div>}
        {data.agentLog.map((l, i) => (
          <div key={i} className="agent-line">{l}</div>
        ))}
      </div>
    </div>
  );
}

export default App;
