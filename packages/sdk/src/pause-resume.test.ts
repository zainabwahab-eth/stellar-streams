import { describe, expect, it, vi } from 'vitest';
import {
  MemoText,
  SorobanDataBuilder,
  Transaction,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import * as SorobanRpc from '@stellar/stellar-sdk/rpc';
import { StreamsError, type SimulationResult } from './index.js';
import {
  CONTRACT_ID,
  contractErrorEvent,
  fakeTransport,
  invokedArgs,
  invokedCall,
  makeClient,
  sendResponse,
  simulationError,
  simulationSuccess,
  trappedResult,
  txResponse,
} from './test-helpers';

const { GetTransactionStatus } = SorobanRpc.Api;

/** A transport where a write simulates, submits, and confirms successfully. */
function writableTransport() {
  const rpc = fakeTransport();
  rpc.simulateTransaction.mockResolvedValue(simulationSuccess(xdr.ScVal.scvVoid()));
  rpc.sendTransaction.mockResolvedValue(sendResponse('PENDING'));
  rpc.getTransaction.mockResolvedValue(txResponse(GetTransactionStatus.SUCCESS));
  return rpc;
}

describe.each(['pause', 'resume'] as const)('%s', (method) => {
  it(`invokes ${method} on the stream contract with the id encoded as u64`, async () => {
    const rpc = writableTransport();

    const { hash } = await makeClient({ transport: rpc })[method](7n);

    expect(hash).toBe('abc123');
    // The same call is simulated, prepared and submitted.
    for (const [tx] of [
      rpc.simulateTransaction.mock.calls[0]!,
      rpc.prepareTransaction.mock.calls[0]!,
    ]) {
      expect(invokedCall(tx)).toEqual({ contractId: CONTRACT_ID, method });
      const args = invokedArgs(tx);
      expect(args).toHaveLength(1);
      expect(args[0]!.switch()).toBe(xdr.ScValType.scvU64());
      expect(scValToNative(args[0]!)).toBe(7n);
    }
    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('encodes number and decimal-string ids as u64 without precision loss', async () => {
    for (const id of [42, '9007199254740993'] as const) {
      const rpc = writableTransport();
      await makeClient({ transport: rpc })[method](id);

      const [arg] = invokedArgs(rpc.simulateTransaction.mock.calls[0]![0]);
      expect(arg!.switch()).toBe(xdr.ScValType.scvU64());
      expect(scValToNative(arg!)).toBe(BigInt(id));
    }
  });

  it('applies the fee and memo write options to the transaction', async () => {
    const rpc = writableTransport();

    await makeClient({ transport: rpc })[method](1, {
      fee: '2500000',
      memo: { type: 'text', value: 'payroll-hold' },
    });

    const tx = rpc.simulateTransaction.mock.calls[0]![0] as Transaction;
    expect(tx.fee).toBe('2500000');
    expect(tx.memo.type).toBe(MemoText);
    expect(tx.memo.value!.toString()).toBe('payroll-hold');
  });

  it('returns the simulation without signing or submitting when simulateOnly is set', async () => {
    const rpc = writableTransport();
    rpc.simulateTransaction.mockResolvedValue(
      simulationSuccess(xdr.ScVal.scvVoid(), {
        minResourceFee: '4321',
        transactionData: new SorobanDataBuilder().setResources(1_000, 200, 100),
        result: { auth: [], retval: xdr.ScVal.scvVoid() },
      }),
    );
    const signTransaction = vi.fn(async (txXdr: string) => txXdr);

    const result: SimulationResult = await makeClient({ transport: rpc, signTransaction })[method](
      3,
      { simulateOnly: true },
    );

    expect(result.minResourceFee).toBe('4321');
    expect(invokedCall(result.transaction).method).toBe(method);
    expect(scValToNative(invokedArgs(result.transaction)[0]!)).toBe(3n);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.prepareTransaction).not.toHaveBeenCalled();
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
  });

  it('honours an aborted signal before any RPC call or wallet prompt', async () => {
    const rpc = writableTransport();
    const controller = new AbortController();
    controller.abort();
    const signTransaction = vi.fn(async (txXdr: string) => txXdr);

    const error = (await makeClient({ transport: rpc, signTransaction })
      [method](1, { signal: controller.signal })
      .catch((e: unknown) => e)) as Error;

    expect(error.name).toBe('AbortError');
    expect(signTransaction).not.toHaveBeenCalled();
    expect(rpc.calls()).toBe(0);
  });

  it.each([
    [4, 'STREAM_NOT_FOUND'],
    [6, 'UNAUTHORIZED'],
    [8, 'ALREADY_CANCELLED'],
    [16, 'STREAM_PAUSED'],
    [17, 'NOT_PAUSED'],
  ] as const)(
    'maps contract error #%i from the simulation onto StreamsError.code %s',
    async (contractCode, code) => {
      const rpc = fakeTransport();
      rpc.simulateTransaction.mockResolvedValue(
        simulationError(`HostError: Error(Contract, #${contractCode})`),
      );
      const signTransaction = vi.fn(async (txXdr: string) => txXdr);

      const error = (await makeClient({ transport: rpc, signTransaction })
        [method](1)
        .catch((e: unknown) => e)) as StreamsError;

      expect(error).toBeInstanceOf(StreamsError);
      expect(error.code).toBe(code);
      expect(error.contractCode).toBe(contractCode);
      expect(error.message).toContain(`Simulation of ${method} failed`);
      expect(signTransaction).not.toHaveBeenCalled();
      expect(rpc.sendTransaction).not.toHaveBeenCalled();
    },
  );

  it('maps a contract error raised at submission through its diagnostics', async () => {
    const rpc = fakeTransport();
    rpc.simulateTransaction.mockResolvedValue(simulationSuccess(xdr.ScVal.scvVoid()));
    rpc.sendTransaction.mockResolvedValue(
      sendResponse('ERROR', {
        errorResult: trappedResult(),
        diagnosticEvents: [contractErrorEvent(8, 'stream already cancelled')],
      }),
    );

    const error = (await makeClient({ transport: rpc })
      [method](1)
      .catch((e: unknown) => e)) as StreamsError;

    expect(error).toBeInstanceOf(StreamsError);
    expect(error.code).toBe('ALREADY_CANCELLED');
    expect(error.contractCode).toBe(8);
  });
});
