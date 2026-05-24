import React, { useState } from 'react';

function TreeNodeRow({ entity, depth = 0, expanded, onToggle, onSelect }) {
  const [isExpanded, setIsExpanded] = useState(expanded ?? (depth === 0));
  const hasChildren = entity.children?.length > 0 || entity.siblings?.length > 0 || entity._divisional_aggregators?.length > 0;
  const rev = entity.revenue_estimate;
  const indentPx = depth * 20;

  const handleToggle = (e) => {
    e.stopPropagation();
    setIsExpanded(!isExpanded);
  };

  const handleSelect = (e) => {
    e.stopPropagation();
    onSelect?.(entity.company);
  };

  // Determine role chip
  let roleChip = entity.role || 'entity';
  if (entity._generated) roleChip = 'AGGREGATOR';

  // Secondary relationships annotation
  const secondaryLabel = entity.secondary_relationships?.length > 0
    ? ` · ${entity.secondary_relationships[0].relationship_type}`
    : '';

  return (
    <div className="tree-node" style={{ marginLeft: `${indentPx}px` }}>
      <div
        className="tree-node-row"
        onClick={handleSelect}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 4px',
          cursor: 'pointer',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {hasChildren && (
          <button
            onClick={handleToggle}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              width: 20,
              height: 20,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-muted)',
            }}
          >
            {isExpanded ? '▼' : '▶'}
          </button>
        )}
        {!hasChildren && <span style={{ width: 20 }} />}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
            {entity.company}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 9,
              backgroundColor: 'var(--surface)',
              color: 'var(--text-muted)',
              padding: '2px 6px',
              borderRadius: 2,
            }}>
              {roleChip}{secondaryLabel}
            </span>
            {rev?.central > 0 && (
              <>
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--accent)',
                }}>
                  ${(rev.central / 1e9).toFixed(1)}B
                </span>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: rev.confidence === 'high' ? 'var(--success)' : rev.confidence === 'medium' ? 'var(--warning)' : 'var(--danger)',
                }} />
              </>
            )}
          </div>
        </div>
      </div>

      {isExpanded && (
        <div>
          {/* Divisional aggregators */}
          {entity._divisional_aggregators?.map((agg) => (
            <div key={agg.company}>
              <TreeNodeRow
                entity={agg}
                depth={depth + 1}
                expanded={true}
                onToggle={onToggle}
                onSelect={onSelect}
              />
              {/* Children of aggregator */}
              {agg.children?.map((child) => (
                <TreeNodeRow
                  key={child.company}
                  entity={child}
                  depth={depth + 2}
                  onSelect={onSelect}
                />
              ))}
            </div>
          ))}

          {/* Regular children/parent chain */}
          {entity.parent && (
            <TreeNodeRow
              entity={entity.parent}
              depth={depth + 1}
              expanded={true}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          )}

          {/* Siblings */}
          {entity.siblings?.map((s) => (
            <TreeNodeRow
              key={s.company}
              entity={s}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}

          {/* Cousins */}
          {entity.intra_parent_cousins?.map((c) => (
            <TreeNodeRow
              key={c.company}
              entity={c}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}

          {/* Children */}
          {entity.children?.map((c) => (
            <TreeNodeRow
              key={c.company}
              entity={c}
              depth={depth + 1}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function TreeView({ tree, onSelect }) {
  if (!tree) return null;

  return (
    <div className="tree-view" style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
      <TreeNodeRow entity={tree} depth={0} expanded={true} onSelect={onSelect} />
    </div>
  );
}
