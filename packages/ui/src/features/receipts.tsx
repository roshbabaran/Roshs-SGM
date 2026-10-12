import { buildReceipt, receiptHtml, type Location, type Receipt, type Sale, type User } from '@sgm/core';
import { useCallback, useState, type ReactNode } from 'react';

import { Banner } from '../Basics';
import { Button } from '../Button';
import { Dialog } from '../Dialog';
import { ReceiptPreview } from '../ReceiptPreview';
import { useCollection, useDeviceSettings, useServices } from '../services';

/** Builds receipts with real branch and cashier names, and prints them with this device's settings. */
export function useReceipts() {
  const { printer } = useServices();
  const settings = useDeviceSettings();
  const { data: users } = useCollection<User>('users');
  const { data: locations } = useCollection<Location>('locations');

  const build = useCallback(
    (sale: Sale): Receipt =>
      buildReceipt(sale, {
        locationName: locations.find((l) => l.id === sale.locationId)?.name ?? sale.locationId,
        cashierName: users.find((u) => u.id === sale.cashierId)?.displayName ?? sale.cashierId,
      }),
    [users, locations],
  );

  const print = useCallback(
    async (receipt: Receipt) => {
      const paperWidthMm = settings?.paperWidthMm ?? 58;
      await printer.print(receiptHtml(receipt, paperWidthMm), { paperWidthMm, printerName: settings?.printerName });
    },
    [printer, settings],
  );

  return { build, print };
}

export function ReceiptDialog({
  sale,
  onClose,
  closeLabel = 'Done',
  actions,
}: {
  sale: Sale | null;
  onClose: () => void;
  closeLabel?: string;
  /** Extra buttons, e.g. "Void sale". */
  actions?: ReactNode;
}) {
  const { build, print } = useReceipts();
  const [status, setStatus] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const [printing, setPrinting] = useState(false);
  const receipt = sale ? build(sale) : null;

  const close = () => {
    setStatus(null);
    onClose();
  };

  const printNow = async () => {
    if (!receipt) return;
    setPrinting(true);
    setStatus(null);
    try {
      await print(receipt);
      setStatus({ tone: 'success', text: 'Sent to the printer.' });
    } catch (e) {
      setStatus({ tone: 'danger', text: `Couldn't print: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog
      visible={!!sale}
      title={sale ? `Receipt ${sale.receiptNo}` : 'Receipt'}
      onClose={close}
      width={460}
      actions={
        <>
          {actions}
          <Button title="Print" icon="print-outline" variant="secondary" onPress={printNow} loading={printing} />
          <Button title={closeLabel} onPress={close} />
        </>
      }
    >
      {receipt ? <ReceiptPreview receipt={receipt} /> : null}
      {status ? <Banner tone={status.tone}>{status.text}</Banner> : null}
    </Dialog>
  );
}
