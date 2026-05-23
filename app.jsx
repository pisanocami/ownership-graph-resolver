import React, { useState, useMemo } from 'react';
import {
  Search,
  Loader2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  ExternalLink,
  Crown,
  Briefcase,
  Building2,
  Star,
  Code,
  GitBranch,
  List,
  Network,
} from 'lucide-react';
import ReactFlow, { Background, Controls, MiniMap, Handle, Position } from 'reactflow';
import 'reactflow/dist/style.css';

// ─── System Prompts ───

const SYSTEM_PROMPT = `Sos un research agent que resuelve corporate ownership graphs. Tu output es un árbol jerárquico verificable. Cada nodo está respaldado por una fuente concreta. Si no podés respaldarlo, no lo emitís. Mejor árbol incompleto que árbol falso.

PROCESO

Paso 1 — Verificación de identidad. Antes de resolver ownership, confirmás CUÁL entidad es (dominio canónico, sector, país). Si el input devuelve más de un match plausible, devolvés disambiguation_required:true con candidatos y parás.

Paso 2 — Distinción legal entity vs operating brand. Marcás node_type: "legal_entity" | "operating_brand" en cada nodo.

Paso 3 — Búsqueda de parent. Queries en orden: "[empresa] parent company" → "[empresa] acquired by" → "[empresa] subsidiary of" → SEC EDGAR si es US-público → press financiera.

Paso 4 — Recursión hasta root. Stop conditions: ultimate parent identificable, PE firm (marcás terminal_layer:"private_equity" y parás), o no hay evidencia.

Paso 5 — Siblings. Para cada nodo intermedio, listás brands al mismo layer, SOLO con fuente verificable.

Paso 6 — Children. Si el input es parent, listás subsidiaries directas.

Paso 7 — Strategic control. Capturás relaciones de control/governance que NO son ownership formal: board members, investors/VCs, PE backers, major shareholders, founders. Distinto de parent/subsidiary. Incluís SOLO con evidencia clara (press release de funding, SEC filing 13D/13G, página oficial de board, M&A announcement). Si el input es una compañía con inversores o board members relevantes, capturálos.

JERARQUÍA DE FUENTES
Tier A: SEC filings, M&A press releases, court filings.
Tier B: Crunchbase/CB Insights citados, WSJ/Bloomberg/Reuters.
Tier C: Trade press, company press releases.
NO aceptables solo: blogs, foros, social media.

ANTI-HALLUCINATION
Sin evidencia de parent → standalone:true. Sin evidence → no emitir. Memoria interna pierde contra search.

CONFIDENCE
high: ≥2 fuentes Tier A/B, <3 años.
medium: 1 Tier A/B o ≥2 Tier C.
low: solo Tier C o >3 años sin reconfirmar.

SALIDA JSON ESTRICTA, SIN PROSA:
{
  "company": str, "domain": str, "node_type": "legal_entity"|"operating_brand",
  "layer": "brand"|"aggregator"|"parent"|"root",
  "operational": bool, "standalone": bool,
  "terminal_layer": "root"|"private_equity"|null,
  "status": "active"|"defunct"|"acquired"|"spun_off",
  "parent": {recursivo} | null,
  "siblings": [{"company": str, "domain": str, "node_type": str}],
  "children": [{recursivo}],
  "acquisition": {"acquired_by": str, "year": int, "source_url": str} | null,
  "non_ownership_relationships": [{"entity": str, "type": str}],
  "strategic_control": [{"entity": str, "relationship": "board_member"|"investor"|"pe_backer"|"major_shareholder"|"founder", "details": str, "source_url": str}],
  "confidence": "high"|"medium"|"low",
  "sources": [url],
  "notes": str,
  "disambiguation_required": bool,
  "disambiguation_candidates": [{"company": str, "sector": str, "country": str}]
}`;

const SYSTEM_PROMPT_COMPACT = `Resuelve corporate ownership rápido. JSON estricto, sin prosa, sin markdown.

1. Verificar identidad (si ambiguo, pedir)
2. Buscar parent: "[empresa] parent company" → "[empresa] acquired by" → SEC
3. Recursionar hasta root
4. Listar siblings y children, SOLO con fuentes Tier A/B
5. Strategic control: board members, investors/VCs, PE backers, founders, major shareholders con fuente verificable

SALIDA COMPACTA (omite notes, non_ownership):
{
  "company": str, "domain": str, "node_type": "legal_entity"|"operating_brand",
  "layer": "brand"|"aggregator"|"parent"|"root",
  "parent": {recursivo} | null,
  "siblings": [{"company": str}],
  "children": [{recursivo}],
  "acquisition": {"acquired_by": str, "year": int} | null,
  "strategic_control": [{"entity": str, "relationship": "board_member"|"investor"|"pe_backer"|"major_shareholder"|"founder", "details": str}],
  "confidence": "high"|"medium"|"low",
  "sources": [url1, url2],
  "disambiguation_required": bool
}`;

// ─── Helpers ───

function safeExtractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace === -1) return null;
  
  let candidate = cleaned.slice(firstBrace);
  
  try {
    return JSON.parse(candidate);
  } catch {
    let closeAttempt = candidate;
    for (let i = 0; i < 15; i++) {
      closeAttempt += '}';
      try {
        return JSON.parse(closeAttempt);
      } catch {
        // Keep trying
      }
    }
  }
  
  return null;
}

function buildChain(focal) {
  const chain = [focal];
  let current = focal;
  while (current?.parent) {
    current = current.parent;
    chain.unshift(current);
  }
  return chain;
}

function confColor(conf) {
  if (conf === 'high') return '#10b981';
  if (conf === 'medium') return '#f59e0b';
  return '#ef4444';
}

// ─── Components ───

function SummaryRow({ result }) {
  if (!result || result.error || result.disambiguation_required) return null;

  const chain = buildChain(result);
  const strategicCount = result.strategic_control?.length || 0;
  const sourceCount = result.sources?.length || 0;

  const statusBadge = result.standalone ? (
    <span style={{
      fontSize: '12px',
      color: '#059669',
      background: '#ecfdf5',
      border: '1px solid #a7f3d0',
      padding: '4px 10px',
      borderRadius: '6px',
      fontWeight: 600,
    }}>
      Standalone company
    </span>
  ) : result.parent ? (
    <span style={{
      fontSize: '12px',
      color: '#0369a1',
      background: '#f0f9ff',
      border: '1px solid #bfdbfe',
      padding: '4px 10px',
      borderRadius: '6px',
      fontWeight: 600,
    }}>
      Subsidiary
    </span>
  ) : null;

  return (
    <div style={{
      background: '#f9fafb',
      border: '1px solid #e5e7eb',
      borderRadius: '8px',
      padding: '16px 20px',
      marginBottom: '24px',
      display: 'flex',
      alignItems: 'center',
      gap: '20px',
      flexWrap: 'wrap',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '200px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0, color: '#111827' }}>
          {result.company}
        </h2>
        {statusBadge}
      </div>

      <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <GitBranch className="w-4 h-4" style={{ color: '#6b7280' }} />
          <span style={{ fontSize: '13px', color: '#6b7280' }}>
            {chain.length} layer{chain.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: confColor(result.confidence),
          }} />
          <span style={{ fontSize: '13px', color: '#6b7280' }}>
            {result.confidence || 'unknown'} confidence
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '13px', color: '#6b7280' }}>
            {sourceCount} source{sourceCount !== 1 ? 's' : ''}
          </span>
        </div>

        {strategicCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Star className="w-4 h-4" style={{ color: '#6b7280' }} />
            <span style={{ fontSize: '13px', color: '#6b7280' }}>
              {strategicCount} relationship{strategicCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Badge({ children, dim }) {
  return (
    <span
      style={{
        fontSize: '11px',
        color: dim ? '#6b7280' : '#0369a1',
        background: dim ? '#f3f4f6' : '#f0f9ff',
        border: `1px solid ${dim ? '#e5e7eb' : '#bfdbfe'}`,
        padding: '2px 6px',
        borderRadius: '4px',
        fontWeight: 500,
      }}
    >
      {children}
    </span>
  );
}

function LayerIcon({ layer, focal }) {
  const color = focal ? '#3b82f6' : '#6b7280';
  const props = { className: 'w-3.5 h-3.5', style: { color, strokeWidth: 2 } };
  if (focal) return <Star {...props} style={{ ...props.style, fill: '#3b82f6' }} />;
  if (layer === 'root' || layer === 'parent') return <Crown {...props} />;
  if (layer === 'aggregator') return <Briefcase {...props} />;
  return <Building2 {...props} />;
}

function ConfidencePill({ conf, sources, verification }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span
          style={{
            width: '5px',
            height: '5px',
            borderRadius: '50%',
            background: confColor(conf),
          }}
        />
        <span style={{ fontSize: '11px', color: '#6b7280' }}>
          {conf || 'unknown'} confidence
        </span>
      </div>
      {sources?.length > 0 && (
        <span style={{ fontSize: '11px', color: '#9ca3af' }}>
          · {sources.length} {sources.length === 1 ? 'source' : 'sources'}
        </span>
      )}
      {verification === 'needs_recent_confirmation' && (
        <span style={{ fontSize: '11px', color: '#f59e0b' }}>· stale</span>
      )}
    </div>
  );
}

function NodeCard({ node, isFocal, compact }) {
  const [showSources, setShowSources] = useState(false);
  if (!node) return null;

  return (
    <div
      style={{
        background: isFocal ? '#f0f9ff' : '#f9fafb',
        border: `1px solid ${isFocal ? '#bfdbfe' : '#e5e7eb'}`,
        padding: compact ? '12px 14px' : '14px 16px',
        borderRadius: '6px',
      }}
    >
      <div style={{ display: 'flex', gap: '10px' }}>
        <div style={{ marginTop: '2px' }}>
          <LayerIcon layer={node.layer} focal={isFocal} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h3
              style={{
                fontSize: compact ? '15px' : '16px',
                fontWeight: 600,
                color: '#111827',
                margin: 0,
              }}
            >
              {node.company}
            </h3>
            {isFocal && <Badge>subject</Badge>}
          </div>

          {node.domain && (
            <p style={{ fontSize: '12px', color: '#6b7280', margin: '3px 0 0 0' }}>
              {node.domain}
            </p>
          )}

          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '8px' }}>
            {node.layer && <Badge>{node.layer}</Badge>}
            {node.node_type && (
              <Badge dim>
                {node.node_type === 'operating_brand' ? 'brand' : 'entity'}
              </Badge>
            )}
            {node.terminal_layer === 'private_equity' && <Badge>PE</Badge>}
            {node.status && node.status !== 'active' && <Badge>{node.status}</Badge>}
            {node.standalone && <Badge dim>standalone</Badge>}
          </div>

          {node.acquisition?.acquired_by && (
            <p style={{ fontSize: '12px', color: '#6b7280', margin: '8px 0 0 0', fontStyle: 'italic' }}>
              Acquired by <span style={{ color: '#111827', fontStyle: 'normal' }}>{node.acquisition.acquired_by}</span>
              {node.acquisition.year && ` · ${node.acquisition.year}`}
            </p>
          )}

          <div style={{ marginTop: '8px' }}>
            <ConfidencePill conf={node.confidence} sources={node.sources} verification={node.verification_status} />
          </div>

          {node.sources?.length > 0 && (
            <div style={{ marginTop: '8px' }}>
              <button
                onClick={() => setShowSources(!showSources)}
                style={{
                  fontSize: '11px',
                  color: '#3b82f6',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '4px',
                }}
              >
                {showSources ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {showSources ? 'hide' : 'show'} sources
              </button>
              {showSources && (
                <ul style={{ marginTop: '6px', paddingLeft: '18px', margin: '6px 0 0 0' }}>
                  {node.sources.map((src, i) => (
                    <li key={i} style={{ fontSize: '11px', lineHeight: 1.5 }}>
                      <a
                        href={src}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: '#3b82f6',
                          textDecoration: 'none',
                          display: 'inline-flex',
                          gap: '4px',
                          wordBreak: 'break-all',
                        }}
                      >
                        <ExternalLink className="w-3 h-3" style={{ flexShrink: 0, marginTop: '1px' }} />
                        <span>{src}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LogPanel({ logs, isOpen, onToggle }) {
  const logEndRef = React.useRef(null);

  React.useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const levelColors = {
    INIT: '#6b7280',
    SYSTEM: '#6b7280',
    TOOL_CALL: '#0284c7',
    TOOL_RESULT: '#d97706',
    TEXT: '#9ca3af',
    JSON_PARSE: '#d97706',
    SUCCESS: '#059669',
    ERROR: '#dc2626',
    COMPLETE: '#059669',
  };

  return (
    <div style={{ marginTop: '32px', borderTop: '1px solid #e5e7eb', paddingTop: '16px' }}>
      <button
        onClick={onToggle}
        style={{
          fontSize: '12px',
          color: logs.length > 0 ? '#3b82f6' : '#9ca3af',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: 0,
          fontWeight: 500,
        }}
      >
        {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        Agent logs · {logs.length} {logs.length === 1 ? 'event' : 'events'}
      </button>

      {isOpen && (
        <div
          style={{
            marginTop: '12px',
            border: '1px solid #e5e7eb',
            background: '#f9fafb',
            borderRadius: '6px',
            maxHeight: '400px',
            overflow: 'auto',
            padding: '12px',
          }}
        >
          {logs.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>
              — no logs yet —
            </div>
          ) : (
            <div>
              {logs.map((log, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '11px',
                    lineHeight: 1.5,
                    marginBottom: '4px',
                    color: levelColors[log.level] || '#9ca3af',
                    display: 'flex',
                    gap: '10px',
                  }}
                >
                  <span style={{ color: '#d1d5db', minWidth: '60px', flexShrink: 0 }}>
                    {log.timestamp}
                  </span>
                  <span
                    style={{
                      color: levelColors[log.level],
                      fontWeight: log.level === 'ERROR' ? 600 : 500,
                      minWidth: '95px',
                      flexShrink: 0,
                    }}
                  >
                    {log.level}
                  </span>
                  <span style={{ color: '#6b7280', wordBreak: 'break-word' }}>
                    {log.message}
                  </span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OwnershipNode({ data }) {
  const { node, isFocal, role } = data;
  const borderColor = isFocal ? '#3b82f6' : '#e5e7eb';
  const bg = isFocal ? '#f0f9ff' : '#ffffff';
  return (
    <div
      style={{
        background: bg,
        border: `2px solid ${borderColor}`,
        borderRadius: '8px',
        padding: '10px 14px',
        minWidth: '180px',
        boxShadow: isFocal ? '0 2px 8px rgba(59,130,246,0.15)' : '0 1px 3px rgba(0,0,0,0.05)',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ background: '#9ca3af' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
        <LayerIcon layer={node.layer} focal={isFocal} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>
          {node.company || '(unknown)'}
        </span>
      </div>
      {node.domain && (
        <div style={{ fontSize: '10px', color: '#6b7280', marginBottom: '4px' }}>{node.domain}</div>
      )}
      <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap' }}>
        {node.layer && (
          <span style={{ fontSize: '9px', color: '#0369a1', background: '#f0f9ff', border: '1px solid #bfdbfe', padding: '1px 5px', borderRadius: '3px', fontWeight: 500 }}>
            {node.layer}
          </span>
        )}
        {role && (
          <span style={{ fontSize: '9px', color: '#6b7280', background: '#f3f4f6', padding: '1px 5px', borderRadius: '3px' }}>
            {role}
          </span>
        )}
        {node.confidence && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '9px', color: '#6b7280' }}>
            <span style={{ width: '5px', height: '5px', borderRadius: '50%', background: confColor(node.confidence) }} />
            {node.confidence}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ background: '#9ca3af' }} />
    </div>
  );
}

const nodeTypes = { ownership: OwnershipNode };

function GraphView({ result }) {
  const { nodes, edges } = useMemo(() => {
    const chain = buildChain(result);
    const nodes = [];
    const edges = [];
    const NODE_W = 220;
    const Y_STEP = 130;

    // Parent chain (vertical, focal at bottom of chain)
    chain.forEach((n, idx) => {
      const isFocal = idx === chain.length - 1;
      nodes.push({
        id: `chain-${idx}`,
        type: 'ownership',
        position: { x: 0, y: idx * Y_STEP },
        data: { node: n, isFocal, role: isFocal ? 'subject' : idx === 0 ? 'root' : 'parent' },
      });
      if (idx > 0) {
        edges.push({
          id: `e-chain-${idx}`,
          source: `chain-${idx - 1}`,
          target: `chain-${idx}`,
          label: 'owns',
          labelStyle: { fontSize: 10, fill: '#6b7280' },
          style: { stroke: '#9ca3af' },
        });
      }
    });

    const focalIdx = chain.length - 1;
    const focalY = focalIdx * Y_STEP;
    const parentIdx = chain.length - 2;

    // Siblings — to the right of focal, connected to parent
    const siblings = result.siblings || [];
    siblings.forEach((sib, i) => {
      const id = `sib-${i}`;
      nodes.push({
        id,
        type: 'ownership',
        position: { x: NODE_W + 120 + (i % 2) * (NODE_W + 40), y: focalY + Math.floor(i / 2) * 100 },
        data: { node: sib, isFocal: false, role: 'sibling' },
      });
      if (parentIdx >= 0) {
        edges.push({
          id: `e-sib-${i}`,
          source: `chain-${parentIdx}`,
          target: id,
          style: { stroke: '#d1d5db', strokeDasharray: '4 4' },
        });
      }
    });

    // Children — below focal
    const children = result.children || [];
    const childY = focalY + Y_STEP;
    const totalW = children.length * (NODE_W + 30);
    const startX = -(totalW / 2) + NODE_W / 2;
    children.forEach((child, i) => {
      const id = `child-${i}`;
      nodes.push({
        id,
        type: 'ownership',
        position: { x: startX + i * (NODE_W + 30), y: childY },
        data: { node: child, isFocal: false, role: 'child' },
      });
      edges.push({
        id: `e-child-${i}`,
        source: `chain-${focalIdx}`,
        target: id,
        style: { stroke: '#9ca3af' },
      });
    });

    return { nodes, edges };
  }, [result]);

  return (
    <div style={{
      height: '550px',
      border: '1px solid #e5e7eb',
      borderRadius: '6px',
      background: '#f9fafb',
    }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#e5e7eb" gap={16} />
        <Controls />
        <MiniMap nodeColor={(n) => (n.data?.isFocal ? '#3b82f6' : '#d1d5db')} pannable zoomable />
      </ReactFlow>
    </div>
  );
}

function StrategicControlSection({ items }) {
  const [open, setOpen] = useState(true);
  const groups = useMemo(() => {
    const g = { board_member: [], investor: [], pe_backer: [], major_shareholder: [], founder: [] };
    items.forEach((it) => {
      const key = g[it.relationship] ? it.relationship : null;
      if (key) g[key].push(it);
    });
    return g;
  }, [items]);

  const groupMeta = [
    { key: 'board_member', label: 'Board Members', keys: ['board_member'] },
    { key: 'investors', label: 'Investors / VCs', keys: ['investor', 'pe_backer'] },
    { key: 'major_shareholder', label: 'Major Shareholders', keys: ['major_shareholder'] },
    { key: 'founder', label: 'Founders', keys: ['founder'] },
  ];

  const relLabel = {
    board_member: 'board member',
    investor: 'investor',
    pe_backer: 'PE backer',
    major_shareholder: 'major shareholder',
    founder: 'founder',
  };

  const renderItem = (it, i) => (
    <div
      key={i}
      style={{
        border: '1px solid #e5e7eb',
        borderRadius: '6px',
        padding: '10px 12px',
        background: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: '#111827' }}>{it.entity}</span>
        <span style={{ fontSize: '10px', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {relLabel[it.relationship] || it.relationship}
        </span>
      </div>
      {it.details && (
        <p style={{ fontSize: '12px', color: '#4b5563', margin: '4px 0 0 0', lineHeight: 1.4 }}>
          {it.details}
        </p>
      )}
      {it.source_url && (
        <a
          href={it.source_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: '11px', color: '#3b82f6', marginTop: '4px', display: 'inline-block', textDecoration: 'none' }}
        >
          source ↗
        </a>
      )}
    </div>
  );

  return (
    <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          color: '#374151',
          fontSize: '12px',
          fontWeight: 600,
        }}
      >
        <span style={{ fontSize: '10px' }}>{open ? '▾' : '▸'}</span>
        Strategic Relationships ({items.length})
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' }}>
          {groupMeta.map((gm) => {
            const list = gm.keys.flatMap((k) => groups[k] || []);
            if (list.length === 0) return null;
            return (
              <div key={gm.key}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 500 }}>
                    {gm.label} ({list.length})
                  </span>
                  <div style={{ flex: 1, borderTop: '1px solid #e5e7eb' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {list.map(renderItem)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultDisplay({ result, rawResponse }) {
  const [showRaw, setShowRaw] = useState(false);
  const [viewMode, setViewMode] = useState('list');

  if (result.error) {
    return (
      <div style={{ border: '1px solid #fed7aa', background: '#fffbeb', padding: '14px', borderRadius: '6px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#92400e', margin: 0 }}>Unable to resolve</h3>
        <p style={{ fontSize: '12px', color: '#b45309', margin: '4px 0 0 0' }}>{result.reason}</p>
        {result.candidates?.length > 0 && (
          <div style={{ marginTop: '10px' }}>
            <p style={{ fontSize: '11px', color: '#9ca3af', fontWeight: 500, margin: 0 }}>Candidates:</p>
            <ul style={{ margin: '6px 0 0 0', paddingLeft: '20px' }}>
              {result.candidates.map((c, i) => (
                <li key={i} style={{ fontSize: '12px', color: '#374151' }}>
                  {c.company} <span style={{ color: '#6b7280' }}>— {c.sector}, {c.country}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (result.disambiguation_required) {
    return (
      <div style={{ border: '1px solid #fed7aa', background: '#fffbeb', padding: '14px', borderRadius: '6px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#92400e', margin: 0 }}>Multiple entities found</h3>
        <p style={{ fontSize: '12px', color: '#b45309', margin: '4px 0 0 0' }}>Specify which entity:</p>
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {result.disambiguation_candidates?.map((c, i) => (
            <div key={i} style={{ background: '#ffffff', border: '1px solid #e5e7eb', padding: '10px', borderRadius: '4px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: '#111827' }}>{c.company}</div>
              <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '2px' }}>
                {c.sector} · {c.country}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const chain = buildChain(result);

  const tabBtn = (mode, label, Icon) => (
    <button
      onClick={() => setViewMode(mode)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '6px 12px',
        fontSize: '12px',
        fontWeight: 500,
        background: viewMode === mode ? '#3b82f6' : '#ffffff',
        color: viewMode === mode ? '#ffffff' : '#6b7280',
        border: `1px solid ${viewMode === mode ? '#3b82f6' : '#e5e7eb'}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <GitBranch className="w-4 h-4" style={{ color: '#9ca3af' }} />
          <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 500 }}>
            Ownership chain · {chain.length} {chain.length === 1 ? 'layer' : 'layers'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '6px' }}>
          {tabBtn('list', 'List', List)}
          {tabBtn('graph', 'Graph', Network)}
        </div>
      </div>

      {viewMode === 'graph' ? (
        <GraphView result={result} />
      ) : (
      <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {chain.map((node, idx) => {
          const isFocal = idx === chain.length - 1;
          return (
            <div key={idx}>
              <NodeCard node={node} isFocal={isFocal} />
              {idx < chain.length - 1 && (
                <div
                  style={{
                    height: '24px',
                    marginLeft: '18px',
                    borderLeft: '1px dashed #d1d5db',
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {result.siblings?.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 500 }}>
              Siblings ({result.siblings.length})
            </span>
            <div style={{ flex: 1, borderTop: '1px solid #e5e7eb' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {result.siblings.map((sib, i) => (
              <NodeCard key={i} node={sib} compact />
            ))}
          </div>
        </div>
      )}

      {result.children?.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
            <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: 500 }}>
              Children ({result.children.length})
            </span>
            <div style={{ flex: 1, borderTop: '1px solid #e5e7eb' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {result.children.map((child, i) => (
              <NodeCard key={i} node={child} compact />
            ))}
          </div>
        </div>
      )}
      </>
      )}

      {result.strategic_control?.length > 0 && (
        <StrategicControlSection items={result.strategic_control} />
      )}

      {result.notes && (
        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb' }}>
          <p style={{ fontSize: '11px', color: '#6b7280', fontWeight: 500, margin: 0 }}>Notes</p>
          <p style={{ fontSize: '12px', color: '#6b7280', margin: '6px 0 0 0', fontStyle: 'italic' }}>
            {result.notes}
          </p>
        </div>
      )}

      <div style={{ marginTop: '24px' }}>
        <button
          onClick={() => setShowRaw(!showRaw)}
          style={{
            fontSize: '11px',
            color: '#6b7280',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            padding: 0,
          }}
        >
          <Code className="w-3 h-3" />
          {showRaw ? 'hide' : 'show'} raw response
        </button>
        {showRaw && (
          <pre
            style={{
              marginTop: '10px',
              padding: '12px',
              background: '#f9fafb',
              fontSize: '11px',
              color: '#374151',
              overflow: 'auto',
              maxHeight: '400px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              border: '1px solid #e5e7eb',
              borderRadius: '4px',
              margin: '10px 0 0 0',
            }}
          >
            {rawResponse || JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───

export default function OwnershipResolver() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [rawResponse, setRawResponse] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);

  const addLog = (level, message) => {
    const now = new Date();
    const timestamp =
      now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) +
      `.${String(now.getMilliseconds()).padStart(3, '0')}`;
    setLogs(prev => [...prev.slice(-99), { timestamp, level, message }]);
  };

  const resolve = async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setRawResponse(null);
    setLogs([]);
    setShowLogs(true);

    const attemptResolve = async (isRetry = false) => {
      const promptToUse = isRetry ? SYSTEM_PROMPT_COMPACT : SYSTEM_PROMPT;
      const promptLabel = isRetry ? 'COMPACT' : 'FULL';

      if (isRetry) {
        addLog('SYSTEM', '━━ RETRY ATTEMPT ━━ Using compact prompt');
      } else {
        addLog('INIT', `Starting resolution for: "${input.trim()}"`);
        addLog('SYSTEM', 'Initializing Claude API call with web_search');
      }

      try {
        addLog('SYSTEM', 'Building request payload');
        const response = await fetch('http://localhost:3002/api/anthropic', {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            system: promptToUse,
            messages: [
              {
                role: 'user',
                content: `Resolvé el ownership tree para: "${input.trim()}"\n\nDevolvé SOLO JSON válido, sin prosa, sin markdown fences.`,
              },
            ],
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          }),
        });

        if (!response.ok) {
          const errText = await response.text();
          addLog('ERROR', `HTTP ${response.status}`);
          throw new Error(`API error: ${response.status}`);
        }

        addLog('SYSTEM', 'Response received from Claude');

        const data = await response.json();
        addLog('SYSTEM', `Response has ${data.content.length} content blocks`);

        data.content.forEach((block, idx) => {
          if (block.type === 'text') {
            const preview = block.text.slice(0, 60).replace(/\n/g, ' ');
            addLog('TEXT', `Block ${idx}: ${preview}${block.text.length > 60 ? '...' : ''}`);
          } else if (block.type === 'mcp_tool_use') {
            addLog('TOOL_CALL', `${block.name}`);
          } else if (block.type === 'mcp_tool_result') {
            const resultText = block.content?.[0]?.text || '(empty)';
            addLog('TOOL_RESULT', `Found ${resultText.length} chars`);
          }
        });

        const textBlocks = (data.content || [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text || '')
          .join('\n');

        setRawResponse(textBlocks);
        addLog('SYSTEM', `Combined ${textBlocks.length} chars`);

        addLog('JSON_PARSE', 'Attempting to parse JSON');
        const parsed = safeExtractJSON(textBlocks);

        if (!parsed) {
          if (isRetry) {
            addLog('ERROR', 'JSON parsing failed on retry');
            throw new Error('JSON parsing failed even with compact prompt.');
          } else {
            addLog('ERROR', 'JSON parsing failed - retrying with compact');
            return { retry: true };
          }
        }

        addLog('JSON_PARSE', 'Successfully parsed');

        if (!parsed.error) {
          const company = parsed.company || '(unknown)';
          addLog('SUCCESS', `Resolved: ${company}`);
          if (parsed.strategic_control?.length > 0) {
            const names = parsed.strategic_control.map((s) => s.entity).join(', ');
            addLog('STRATEGIC_CONTROL', `Found ${parsed.strategic_control.length} control holders (${names})`);
          }
        }

        setResult(parsed);
        addLog('COMPLETE', 'Done');
        return { retry: false, result: parsed };
      } catch (err) {
        addLog('ERROR', err.message);
        setError(err.message || 'Unknown error');
        return { retry: false, result: null };
      }
    };

    const firstAttempt = await attemptResolve(false);
    if (firstAttempt.retry) {
      const retryAttempt = await attemptResolve(true);
      if (!retryAttempt.retry && retryAttempt.result) {
        setResult(retryAttempt.result);
      }
    }

    setLoading(false);
  };

  const examples = ['Nectar', 'Liberty Safe', 'Whole Foods', 'Beats Electronics'];

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#ffffff',
        color: '#111827',
        padding: '40px 24px 60px',
      }}
    >
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        {/* Header - Zone 1: Compact Branding */}
        <header style={{ marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '8px' }}>
            <div style={{ fontSize: '10px', color: '#9ca3af', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
              Growth Signal
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: 600, margin: 0, color: '#111827' }}>
              Ownership Graph Resolver
            </h1>
          </div>
          <p style={{ fontSize: '13px', color: '#6b7280', margin: 0, lineHeight: 1.5, maxWidth: '600px' }}>
            Resolve corporate ownership chains with verified sources
          </p>
        </header>

        {/* Zone 2: Dominant Search Input */}
        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <Search className="w-5 h-5" style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && resolve()}
                placeholder="Enter company or domain, e.g. mercury.com"
                disabled={loading}
                style={{
                  width: '100%',
                  background: '#ffffff',
                  border: '2px solid #d1d5db',
                  borderRadius: '8px',
                  padding: '14px 16px 14px 44px',
                  fontSize: '16px',
                  outline: 'none',
                  fontWeight: 500,
                }}
                onFocus={(e) => (e.target.style.borderColor = '#3b82f6')}
                onBlur={(e) => (e.target.style.borderColor = '#d1d5db')}
              />
            </div>
            <button
              onClick={resolve}
              disabled={loading || !input.trim()}
              style={{
                padding: '14px 28px',
                background: loading || !input.trim() ? '#f3f4f6' : '#3b82f6',
                color: loading || !input.trim() ? '#9ca3af' : '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontSize: '15px',
                fontWeight: 600,
                cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                if (!loading && input.trim()) e.currentTarget.style.background = '#2563eb';
              }}
              onMouseLeave={(e) => {
                if (!loading && input.trim()) e.currentTarget.style.background = '#3b82f6';
              }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Resolving
                </>
              ) : (
                'Resolve'
              )}
            </button>
          </div>
        </div>

        {/* Zone 3: Example Chips (Secondary) */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: '#9ca3af', fontWeight: 500 }}>Examples:</span>
            {examples.map((ex) => (
              <button
                key={ex}
                onClick={() => setInput(ex)}
                disabled={loading}
                style={{
                  fontSize: '13px',
                  color: '#3b82f6',
                  background: '#f0f9ff',
                  border: '1px solid #bfdbfe',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  cursor: 'pointer',
                  fontWeight: 500,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = '#e0f2fe';
                  e.currentTarget.style.borderColor = '#3b82f6';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = '#f0f9ff';
                  e.currentTarget.style.borderColor = '#bfdbfe';
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ border: '1px solid #e5e7eb', background: '#f9fafb', padding: '16px', borderRadius: '8px', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
            <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#3b82f6' }} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 500 }}>Investigating...</div>
              <div style={{ fontSize: '12px', color: '#6b7280', marginTop: '2px' }}>Searching · verifying · walking chain</div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ border: '1px solid #fee2e2', background: '#fef2f2', padding: '14px', borderRadius: '8px', display: 'flex', gap: '12px', marginBottom: '24px' }}>
            <AlertCircle className="w-4 h-4" style={{ color: '#dc2626', flexShrink: 0, marginTop: '2px' }} />
            <div>
              <div style={{ fontSize: '14px', fontWeight: 500, color: '#7f1d1d' }}>Error</div>
              <div style={{ fontSize: '12px', color: '#991b1b', margin: '4px 0 0 0' }}>{error}</div>
            </div>
          </div>
        )}

        {/* Result */}
        {result && <ResultDisplay result={result} rawResponse={rawResponse} />}

        {/* Logs */}
        <LogPanel logs={logs} isOpen={showLogs} onToggle={() => setShowLogs(!showLogs)} />

        {/* Footer */}
        <div style={{ marginTop: '48px', paddingTop: '16px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#9ca3af' }}>
          <span>Growth Signal · Ownership Resolution</span>
          <span>Claude 3.5 Sonnet · Web Search · 4k tokens</span>
        </div>
      </div>
    </div>
  );
}