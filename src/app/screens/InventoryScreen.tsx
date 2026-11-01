import { useState, useEffect } from 'react';
import type { Item } from '../../domain/schema';
import { stockValuation } from '../../domain/queries';
import { useApp } from '../useApp';
import { useAppRoute, useNavigation } from '../navigation';
import { appRoute } from '../router';
import { downloadText, toCsv } from '../../adapters/csv';
import { numberingPolicy, previewCodes } from '../../domain/numbering';
import { EmptyState, Field, Modal, Panel } from '../components';
import { humanDate, money, peso, quantity, titleCase } from '../format';
import { focusField, moneyField, requiredField } from '../forms';
import { hasAnyRole } from '../permissions';

type MovementKind =
  | 'receipt'
  | 'issue'
  | 'transfer'
  | 'customer_return'
  | 'supplier_return'
  | 'count';

export function InventoryScreen() {
  const api = useApp();
  const route = useAppRoute();
  const { navigate } = useNavigation();
  const page =
    route?.page === 'movements' || route?.page === 'locations' || route?.page === 'valuation'
      ? route.page
      : 'items';
  const { state, workspaceId, access } = api;
  const [itemOpen, setItemOpen] = useState(false);
  const [itemForm, setItemForm] = useState({ sku: '', name: '', baseUnit: 'pc' });
  const [locationOpen, setLocationOpen] = useState(false);
  const [locationErrors, setLocationErrors] = useState<{ code?: string; name?: string }>({});
  const [locationForm, setLocationForm] = useState({ code: '', name: '' });
  const [movementOpen, setMovementOpen] = useState(false);
  const [movementForm, setMovementForm] = useState({
    kind: 'receipt' as MovementKind,
    itemId: '',
    locationId: '',
    toLocationId: '',
    date: api.clock.today,
    quantity: '',
    unitCost: '',
    purpose: '',
    issueMovementId: '',
    receiptMovementId: '',
    countedQuantity: '',
    reason: '',
  });
  const [details, setDetails] = useState<Item | null>(null);

  const inventoryStatus = api.productStatus('inventory');
  const inventoryActive = inventoryStatus === 'active';
  const canWrite = inventoryActive && hasAnyRole(access, 'inventory_officer', 'company_admin', 'accountant');
  const items = state.items.filter((item) => item.workspaceId === workspaceId);
  const locations = state.locations.filter((location) => location.workspaceId === workspaceId && location.active);
  const valuation = stockValuation(state, workspaceId);
  const movements = state.movements
    .filter((movement) => movement.workspaceId === workspaceId)
    .slice()
    .sort((left, right) => right.sequence - left.sequence);
  const itemById = (itemId: string) => state.items.find((item) => item.id === itemId);
  const locationLabel = (locationId: string | null) =>
    locationId ? state.locations.find((location) => location.id === locationId)?.code ?? locationId : '—';

  useEffect(() => {
    const recordId = route?.recordId;
    if (!recordId) {
      setDetails(null);
      return;
    }
    const item = state.items.find(
      (candidate) => candidate.id === recordId && candidate.workspaceId === workspaceId,
    );
    setDetails(item ?? null);
  }, [route?.recordId, state.items, workspaceId]);

  const openMovement = (kind: MovementKind, itemId?: string) => {
    const selectedItem = itemId ?? items[0]?.id ?? '';
    const itemIssues = movements.filter(
      (movement) => movement.itemId === selectedItem && movement.type === 'issue',
    );
    const itemReceipts = movements.filter(
      (movement) => movement.itemId === selectedItem && movement.type === 'receipt',
    );
    setMovementForm({
      kind,
      itemId: selectedItem,
      locationId: locations[0]?.id ?? '',
      toLocationId: locations[1]?.id ?? locations[0]?.id ?? '',
      date: api.clock.today,
      quantity: '',
      unitCost: '',
      purpose: '',
      issueMovementId: itemIssues[0]?.id ?? '',
      receiptMovementId: itemReceipts[0]?.id ?? '',
      countedQuantity: '',
      reason: '',
    });
    setMovementOpen(true);
  };

  const currentItem = itemById(movementForm.itemId);
  const currentIssues = movements.filter(
    (movement) => movement.itemId === movementForm.itemId && movement.type === 'issue',
  );
  const currentReceipts = movements.filter(
    (movement) => movement.itemId === movementForm.itemId && movement.type === 'receipt',
  );

  const submitItem = () => {
    const sku = requiredField(itemForm.sku, 'SKU');
    const name = requiredField(itemForm.name, 'Item name');
    const unit = requiredField(itemForm.baseUnit, 'Base unit');
    if (!sku.ok || !name.ok || !unit.ok) {
      api.notify('error', 'Item is incomplete', sku.message || name.message || unit.message);
      return;
    }
    const result = api.dispatch({
      type: 'item.create',
      input: { sku: sku.value ?? '', name: name.value ?? '', baseUnit: unit.value ?? '' },
    });
    if (result) setItemOpen(false);
  };

  const locationPolicy = numberingPolicy(state, workspaceId, 'location');

  const submitLocation = () => {
    const code = locationPolicy.manualOverride
      ? requiredField(locationForm.code, 'location code')
      : { ok: true as const, value: '', message: '' };
    const name = requiredField(locationForm.name, 'location name');
    setLocationErrors({
      code: code.ok ? undefined : code.message,
      name: name.ok ? undefined : name.message,
    });
    if (!code.ok || !name.ok) {
      focusField(!code.ok ? 'location-code' : 'location-name');
      api.notify('error', 'Location is incomplete', code.message || name.message);
      return;
    }
    const result = api.dispatch({
      type: 'location.create',
      input: { code: locationPolicy.manualOverride ? locationForm.code : '', name: locationForm.name },
    });
    if (result) {
      setLocationErrors({});
      setLocationOpen(false);
    }
  };

  const submitMovement = () => {
    const parsedQuantity = moneyField(movementForm.quantity, 'quantity');
    const quantityValue = Number(movementForm.quantity);
    const quantityMilli = Math.round(quantityValue * 1000);
    if (!Number.isFinite(quantityValue) || quantityMilli <= 0) {
      api.notify('error', 'Quantity invalid', 'Enter a positive quantity with up to three decimal places.');
      return;
    }
    let command;
    if (movementForm.kind === 'receipt') {
      const cost = moneyField(movementForm.unitCost, 'unit cost');
      if (!cost.ok || cost.value === null) {
        api.notify('error', 'Unit cost invalid', cost.message);
        return;
      }
      command = {
        type: 'movement.receipt' as const,
        input: {
          itemId: movementForm.itemId,
          locationId: movementForm.locationId,
          occurredOn: movementForm.date,
          quantityMilli,
          unitCostCentavos: cost.value,
        },
      };
    } else if (movementForm.kind === 'issue') {
      command = {
        type: 'movement.issue' as const,
        input: {
          itemId: movementForm.itemId,
          locationId: movementForm.locationId,
          occurredOn: movementForm.date,
          quantityMilli,
          purpose: movementForm.purpose,
        },
      };
    } else if (movementForm.kind === 'transfer') {
      command = {
        type: 'movement.transfer' as const,
        input: {
          itemId: movementForm.itemId,
          fromLocationId: movementForm.locationId,
          toLocationId: movementForm.toLocationId,
          occurredOn: movementForm.date,
          quantityMilli,
        },
      };
    } else if (movementForm.kind === 'customer_return') {
      command = {
        type: 'movement.customerReturn' as const,
        input: {
          itemId: movementForm.itemId,
          locationId: movementForm.locationId,
          occurredOn: movementForm.date,
          quantityMilli,
          issueMovementId: movementForm.issueMovementId,
          reason: movementForm.reason,
        },
      };
    } else if (movementForm.kind === 'supplier_return') {
      command = {
        type: 'movement.supplierReturn' as const,
        input: {
          itemId: movementForm.itemId,
          locationId: movementForm.locationId,
          occurredOn: movementForm.date,
          quantityMilli,
          receiptMovementId: movementForm.receiptMovementId,
          reason: movementForm.reason,
        },
      };
    } else {
      const countValue = Number(movementForm.countedQuantity);
      const countedMilli = Math.round(countValue * 1000);
      if (!Number.isFinite(countValue) || countedMilli < 0) {
        api.notify('error', 'Counted quantity invalid', 'Enter zero or a positive quantity.');
        return;
      }
      const cost = movementForm.unitCost.trim() ? moneyField(movementForm.unitCost, 'unit cost') : null;
      if (cost && (!cost.ok || cost.value === null)) {
        api.notify('error', 'Unit cost invalid', cost.message);
        return;
      }
      command = {
        type: 'movement.count' as const,
        input: {
          itemId: movementForm.itemId,
          locationId: movementForm.locationId,
          occurredOn: movementForm.date,
          countedQuantityMilli: countedMilli,
          unitCostCentavos: cost?.value ?? null,
          reason: movementForm.reason,
        },
      };
    }
    if (parsedQuantity.value === null && movementForm.kind !== 'count') {
      // parsed for message only; quantityMilli is the authoritative parsed integer.
    }
    const result = api.dispatch(command);
    if (result) setMovementOpen(false);
  };

  const exportStock = () => {
    const rows = valuation.rows.map((row) => ({
      sku: row.sku,
      name: row.name,
      base_unit: row.baseUnit,
      quantity_milli: row.quantityMilli,
      value_centavos: row.valueCentavos,
      average_unit_cost_centavos: row.averageUnitCostCentavos,
    }));
    downloadText('ece-accounting-stock-valuation.csv', toCsv(rows));
  };

  const exportMovements = () => {
    const rows = movements.map((movement) => ({
      sequence: movement.sequence,
      type: movement.type,
      occurred_on: movement.occurredOn,
      item: itemById(movement.itemId)?.sku ?? movement.itemId,
      location: locationLabel(movement.locationId),
      quantity_milli: movement.quantityMilli,
      value_centavos: movement.valueCentavos,
      source_type: movement.sourceType,
      source_id: movement.sourceId,
      journal_id: movement.journalId ?? '',
      reason: movement.reason ?? '',
    }));
    downloadText('ece-accounting-inventory-movements.csv', toCsv(rows));
  };

  return (
    <div className="screen">
      {inventoryStatus !== 'active' && (
        <div className="callout callout-warn" role="status">
          <strong>Inventory is {inventoryStatus}.</strong> Stock records stay readable and
          exportable; movements cannot be written.
        </div>
      )}
      {(page === 'items' || page === 'valuation') && (
        <div className="stat-row">
          <div className="stat">
            <span>Stock value</span>
            <strong>{peso(valuation.totalValueCentavos)}</strong>
          </div>
          <div className="stat">
            <span>On-hand quantity (base units)</span>
            <strong>{quantity(valuation.totalQuantityMilli)}</strong>
          </div>
          <div className="stat">
            <span>Active items</span>
            <strong>{items.filter((item) => item.active).length}</strong>
          </div>
          <div className="stat">
            <span>Locations</span>
            <strong>{locations.length}</strong>
          </div>
        </div>
      )}

      {page === 'items' && (
        <Panel
          title="Items"
          subtitle="Items are company-scoped stock master records. The SKU is an external identifier; the immutable item ID is the relationship key."
          actions={
            <button
              type="button"
              className="primary"
              onClick={() => {
                setItemForm({ sku: '', name: '', baseUnit: 'pc' });
                setItemOpen(true);
              }}
              disabled={!canWrite}
            >
              New item
            </button>
          }
        >
          {items.length === 0 ? (
            <EmptyState title="No items for this company" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Item master</caption>
                <thead>
                  <tr>
                    <th scope="col">Item No.</th>
                    <th scope="col">SKU</th>
                    <th scope="col">Name</th>
                    <th scope="col">Base unit</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td><code>{item.itemNo}</code></td>
                      <th scope="row">{item.sku}</th>
                      <td>{item.name}</td>
                      <td>{item.baseUnit}</td>
                      <td>{item.active ? 'Active' : 'Inactive'}</td>
                      <td className="actions">
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => navigate(appRoute('inventory', 'items', { recordId: item.id }))}
                        >
                          View details
                        </button>
                        <button type="button" className="link-button" disabled={!canWrite} onClick={() => openMovement('receipt', item.id)}>
                          Receive stock
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {page === 'locations' && (
        <Panel
          title="Locations"
          subtitle="Stock is held per location. Transfers keep both sides in the same company and preserve the movement trail."
          actions={
            <button
              type="button"
              className="primary"
              onClick={() => {
                setLocationForm({ code: '', name: '' });
                setLocationOpen(true);
              }}
              disabled={!canWrite}
            >
              New location
            </button>
          }
        >
          {locations.length === 0 ? (
            <EmptyState title="No locations for this company" />
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <caption>Stock locations</caption>
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">On-hand lines</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {locations.map((location) => {
                    const lines = valuation.rows.filter((row) =>
                      row.locations.some((entry) => entry.locationId === location.id && entry.quantityMilli !== 0),
                    );
                    return (
                      <tr key={location.id}>
                        <th scope="row">{location.code}</th>
                        <td>{location.name}</td>
                        <td className="numeric">{lines.length}</td>
                        <td>{location.active ? 'Active' : 'Inactive'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {page === 'valuation' && (
      <Panel
        title="Stock valuation"
        subtitle="One company-wide moving weighted-average pool per item, with the exact residual value kept when the pool is fully issued."
        actions={
          <button type="button" onClick={exportStock}>
            Export valuation CSV
          </button>
        }
      >
        {valuation.rows.length === 0 ? (
          <EmptyState title="No items for this company" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Inventory valuation by item</caption>
              <thead>
                <tr>
                  <th scope="col">SKU</th>
                  <th scope="col">Item</th>
                  <th scope="col" className="numeric">
                    On hand
                  </th>
                  <th scope="col" className="numeric">
                    Average unit cost
                  </th>
                  <th scope="col" className="numeric">
                    Value
                  </th>
                  <th scope="col">Locations</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {valuation.rows.map((row) => {
                  return (
                    <tr key={row.itemId}>
                      <th scope="row">{row.sku}</th>
                      <td>{row.name}</td>
                      <td className="numeric">{quantity(row.quantityMilli, row.baseUnit)}</td>
                      <td className="numeric">{money(row.averageUnitCostCentavos)}</td>
                      <td className="numeric">{money(row.valueCentavos)}</td>
                      <td>
                        {row.locations.length === 0
                          ? '—'
                          : row.locations
                              .map((location) => `${location.code}: ${quantity(location.quantityMilli, row.baseUnit)}`)
                              .join(' · ')}
                      </td>
                      <td className="actions">
                        <button type="button" className="link-button" disabled={!canWrite} onClick={() => openMovement('receipt', row.itemId)}>
                          Receive
                        </button>
                        <button type="button" className="link-button" disabled={!canWrite} onClick={() => openMovement('issue', row.itemId)}>
                          Issue
                        </button>
                        <button type="button" className="link-button" disabled={!canWrite} onClick={() => openMovement('transfer', row.itemId)}>
                          Transfer
                        </button>
                        <button type="button" className="link-button" disabled={!canWrite} onClick={() => openMovement('count', row.itemId)}>
                          Count
                        </button>
                        <button type="button" className="link-button" onClick={() => navigate(appRoute('inventory', 'items', { recordId: row.itemId }))}>
                          History
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="total-row">
                  <th scope="row" colSpan={4}>
                    Total inventory value
                  </th>
                  <td className="numeric">{money(valuation.totalValueCentavos)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Panel>
      )}

      {page === 'movements' && (
      <Panel
        title="Movement history"
        subtitle="Every valued movement keeps its source, effect key, quantity, and value. Negative location stock and out-of-order valued movements are rejected."
        actions={
          <>
            <button type="button" onClick={exportMovements}>
              Export movements CSV
            </button>
            <button type="button" className="primary" onClick={() => openMovement('customer_return')} disabled={!canWrite}>
              Customer return
            </button>
            <button type="button" onClick={() => openMovement('supplier_return')} disabled={!canWrite}>
              Supplier return
            </button>
          </>
        }
      >
        {movements.length === 0 ? (
          <EmptyState title="No stock movements yet" />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <caption>Stock movement history</caption>
              <thead>
                <tr>
                  <th scope="col">Seq</th>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col">Item</th>
                  <th scope="col">Location</th>
                  <th scope="col" className="numeric">
                    Quantity
                  </th>
                  <th scope="col" className="numeric">
                    Value
                  </th>
                  <th scope="col">Source</th>
                  <th scope="col">Journal</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => (
                  <tr key={movement.id}>
                    <td>{movement.sequence}</td>
                    <td>{humanDate(movement.occurredOn)}</td>
                    <td>{titleCase(movement.type)}</td>
                    <td>{itemById(movement.itemId)?.sku ?? movement.itemId}</td>
                    <td>
                      {locationLabel(movement.locationId)}
                      {movement.toLocationId ? ` → ${locationLabel(movement.toLocationId)}` : ''}
                    </td>
                    <td className="numeric">{quantity(movement.quantityMilli, itemById(movement.itemId)?.baseUnit ?? 'unit')}</td>
                    <td className="numeric">{money(movement.valueCentavos)}</td>
                    <td>{movement.sourceType}</td>
                    <td>{movement.journalId ?? <span className="muted">standalone</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      )}

      <Modal
        open={itemOpen}
        title="Create inventory item"
        onClose={() => setItemOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setItemOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitItem}>
              Create item
            </button>
          </>
        }
      >
        <Field label="SKU" htmlFor="item-sku">
          <input id="item-sku" value={itemForm.sku} onChange={(event) => setItemForm({ ...itemForm, sku: event.target.value })} />
        </Field>
        <Field label="Item name" htmlFor="item-name">
          <input id="item-name" value={itemForm.name} onChange={(event) => setItemForm({ ...itemForm, name: event.target.value })} />
        </Field>
        <Field label="Base unit" htmlFor="item-unit" hint="One base unit only; conversions are out of scope for this mockup.">
          <input id="item-unit" value={itemForm.baseUnit} onChange={(event) => setItemForm({ ...itemForm, baseUnit: event.target.value })} />
        </Field>
      </Modal>

      <Modal
        open={locationOpen}
        title="Create stock location"
        onClose={() => setLocationOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setLocationOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitLocation}>
              Create location
            </button>
          </>
        }
      >
        {locationPolicy.manualOverride ? (
          <Field label="Code (manual override)" htmlFor="location-code" error={locationErrors.code}>
            <input
              id="location-code"
              value={locationForm.code}
              onChange={(event) => setLocationForm({ ...locationForm, code: event.target.value })}
            />
          </Field>
        ) : (
          <p className="form-note">
            Location code will be allocated:{' '}
            <code>{previewCodes(state, workspaceId, 'location', 1)[0]}</code>
          </p>
        )}
        <Field label="Name" htmlFor="location-name" error={locationErrors.name}>
          <input
            id="location-name"
            value={locationForm.name}
            onChange={(event) => setLocationForm({ ...locationForm, name: event.target.value })}
          />
        </Field>
      </Modal>

      <Modal
        open={movementOpen}
        wide
        title="Post stock movement"
        onClose={() => setMovementOpen(false)}
        footer={
          <>
            <button type="button" onClick={() => setMovementOpen(false)}>
              Cancel
            </button>
            <button type="button" className="primary" onClick={submitMovement}>
              Post movement
            </button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Movement type" htmlFor="movement-kind">
            <select
              id="movement-kind"
              value={movementForm.kind}
              onChange={(event) => setMovementForm({ ...movementForm, kind: event.target.value as MovementKind })}
            >
              <option value="receipt">Receipt</option>
              <option value="issue">Issue</option>
              <option value="transfer">Transfer</option>
              <option value="customer_return">Customer return</option>
              <option value="supplier_return">Supplier return</option>
              <option value="count">Physical count</option>
            </select>
          </Field>
          <Field label="Item" htmlFor="movement-item">
            <select
              id="movement-item"
              value={movementForm.itemId}
              onChange={(event) => setMovementForm({ ...movementForm, itemId: event.target.value })}
            >
              {items.filter((item) => item.active).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.sku} · {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={movementForm.kind === 'transfer' ? 'From location' : 'Location'} htmlFor="movement-location">
            <select
              id="movement-location"
              value={movementForm.locationId}
              onChange={(event) => setMovementForm({ ...movementForm, locationId: event.target.value })}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.code} · {location.name}
                </option>
              ))}
            </select>
          </Field>
          {movementForm.kind === 'transfer' && (
            <Field label="To location" htmlFor="movement-to-location">
              <select
                id="movement-to-location"
                value={movementForm.toLocationId}
                onChange={(event) => setMovementForm({ ...movementForm, toLocationId: event.target.value })}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.code} · {location.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Movement date" htmlFor="movement-date" hint="Valued movements must not be backdated before the item's latest movement.">
            <input
              id="movement-date"
              type="date"
              value={movementForm.date}
              onChange={(event) => setMovementForm({ ...movementForm, date: event.target.value })}
            />
          </Field>
          {movementForm.kind === 'count' ? (
            <Field label="Counted quantity" htmlFor="movement-counted">
              <input
                id="movement-counted"
                inputMode="decimal"
                value={movementForm.countedQuantity}
                onChange={(event) => setMovementForm({ ...movementForm, countedQuantity: event.target.value })}
              />
            </Field>
          ) : (
            <Field
              label="Quantity"
              htmlFor="movement-quantity"
              hint={`Enter in the item's base unit (${currentItem?.baseUnit ?? 'unit'}). For example, 2.5.`}
            >
              <input
                id="movement-quantity"
                inputMode="decimal"
                value={movementForm.quantity}
                onChange={(event) => setMovementForm({ ...movementForm, quantity: event.target.value })}
              />
            </Field>
          )}
          {(movementForm.kind === 'receipt' || movementForm.kind === 'count') && (
            <Field label="Unit cost (PHP, optional for gain count)" htmlFor="movement-cost">
              <input
                id="movement-cost"
                inputMode="decimal"
                value={movementForm.unitCost}
                onChange={(event) => setMovementForm({ ...movementForm, unitCost: event.target.value })}
              />
            </Field>
          )}
          {movementForm.kind === 'issue' && (
            <Field label="Purpose" htmlFor="movement-purpose">
              <input
                id="movement-purpose"
                value={movementForm.purpose}
                onChange={(event) => setMovementForm({ ...movementForm, purpose: event.target.value })}
              />
            </Field>
          )}
          {movementForm.kind === 'customer_return' && (
            <Field label="Original issue" htmlFor="movement-issue">
              <select
                id="movement-issue"
                value={movementForm.issueMovementId}
                onChange={(event) => setMovementForm({ ...movementForm, issueMovementId: event.target.value })}
              >
                {currentIssues.length === 0 && <option value="">No issues for this item</option>}
                {currentIssues.map((movement) => (
                  <option key={movement.id} value={movement.id}>
                    {humanDate(movement.occurredOn)} · {quantity(movement.quantityMilli, currentItem?.baseUnit ?? 'unit')} · {money(movement.valueCentavos)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {movementForm.kind === 'supplier_return' && (
            <Field label="Original receipt" htmlFor="movement-receipt">
              <select
                id="movement-receipt"
                value={movementForm.receiptMovementId}
                onChange={(event) => setMovementForm({ ...movementForm, receiptMovementId: event.target.value })}
              >
                {currentReceipts.length === 0 && <option value="">No receipts for this item</option>}
                {currentReceipts.map((movement) => (
                  <option key={movement.id} value={movement.id}>
                    {humanDate(movement.occurredOn)} · {quantity(movement.quantityMilli, currentItem?.baseUnit ?? 'unit')} · {money(movement.valueCentavos)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {['customer_return', 'supplier_return', 'count'].includes(movementForm.kind) && (
          <Field label="Reason" htmlFor="movement-reason" hint="Required for returns and count adjustments; recorded in history.">
            <input
              id="movement-reason"
              value={movementForm.reason}
              onChange={(event) => setMovementForm({ ...movementForm, reason: event.target.value })}
            />
          </Field>
        )}
        <p className="callout callout-info">
          With Accounting active, a receipt, issue, transfer, return, or count posts its linked
          journal at the same time. When the company uses Inventory standalone, the movement is
          recorded with no general-ledger journal and is labelled standalone.
        </p>
      </Modal>

      <Modal
        open={details !== null}
        wide
        title={details ? `${details.itemNo} · ${details.sku} movement history` : 'Item history'}
        onClose={() => navigate(appRoute('inventory', 'items'))}
      >
        {details && (
          <>
            <p>
              {details.name} · base unit {details.baseUnit} · on hand{' '}
              {quantity(
                movements
                  .filter((movement) => movement.itemId === details.id)
                  .reduce(
                    (total, movement) =>
                      total +
                      (movement.type === 'issue' || movement.type === 'supplier_return' ? -movement.quantityMilli : movement.quantityMilli),
                    0,
                  ),
                details.baseUnit,
              )}
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="numeric">
                    Quantity
                  </th>
                  <th scope="col" className="numeric">
                    Value
                  </th>
                  <th scope="col">Reason / source</th>
                </tr>
              </thead>
              <tbody>
                {movements
                  .filter((movement) => movement.itemId === details.id)
                  .map((movement) => (
                    <tr key={movement.id}>
                      <td>{humanDate(movement.occurredOn)}</td>
                      <td>{titleCase(movement.type)}</td>
                      <td className="numeric">{quantity(movement.quantityMilli, details.baseUnit)}</td>
                      <td className="numeric">{money(movement.valueCentavos)}</td>
                      <td>{movement.reason ?? movement.sourceType}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </>
        )}
      </Modal>
    </div>
  );
}
