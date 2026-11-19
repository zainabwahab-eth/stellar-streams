import { beforeEach, describe, expect, it } from 'vitest';
import { Keypair, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { ContractResponseError } from '@stellar-starter-kit/types';
import { StreamsError } from './index';
import {
  CONTRACT_ID,
  PUBLIC_KEY,
  fakeTransport,
  invokedArgs,
  invokedCall,
  makeClient,
  simulateByMethod,
  simulationError,
  simulationSuccess,
  streamScVal,
} from './test-helpers';

/** A `VestingSummary` struct as the contract returns it. */
function vestingSummaryScVal(vested: bigint, claimable: bigint): xdr.ScVal {
  return nativeToScVal(
    { vested, claimable },
    { type: { vested: ['symbol', 'i128'], claimable: ['symbol', 'i128'] } },
  );
}

const TREASURY = Keypair.random().publicKey();

describe('read call decoding', () => {
  let rpc: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    rpc = fakeTransport();
    rpc.simulateTransaction.mockImplementation(
      simulateByMethod({
        get_stream: streamScVal({
          id: 7n,
          total_amount: 5_000_000_000n,
          withdrawn: 1_250_000_000n,
          start_time: 1_700_000_000n,
          end_time: 1_700_086_400n,
          cliff_time: 1_700_003_600n,
          cancelled: true,
        }),
        get_config: nativeToScVal(
          { admin: PUBLIC_KEY, treasury: TREASURY, fee_bps: 250 },
          {
            type: {
              admin: ['symbol', 'address'],
              treasury: ['symbol', 'address'],
              fee_bps: ['symbol', 'u32'],
            },
          },
        ),
        claimable: nativeToScVal(1_250_000_000n, { type: 'i128' }),
        vested: nativeToScVal(2_500_000_000n, { type: 'i128' }),
        next_stream_id: nativeToScVal(9_007_199_254_740_993n, { type: 'u64' }),
        vesting_summary: vestingSummaryScVal(2_500_000_000n, 1_250_000_000n),
      }),
    );
  });

  it('decodes get_stream into the domain Stream shape', async () => {
    const stream = await makeClient({ transport: rpc }).getStream(7);

    expect(stream).toEqual({
      id: '7',
      sender: PUBLIC_KEY,
      recipient: PUBLIC_KEY,
      token: CONTRACT_ID,
      totalAmount: '5000000000',
      withdrawn: '1250000000',
      startTime: 1_700_000_000,
      endTime: 1_700_086_400,
      cliffTime: 1_700_003_600,
      cancelled: true,
      label: '',
      reference: '',
    });
  });

  it('returns null for a stream that does not exist', async () => {
    // `get_stream` returns Option<Stream>; None decodes to a void ScVal.
    rpc.simulateTransaction.mockResolvedValue(simulationSuccess(xdr.ScVal.scvVoid()));

    await expect(makeClient({ transport: rpc }).getStream(99)).resolves.toBeNull();
  });

  it('decodes get_config with the fee in basis points', async () => {
    const config = await makeClient({ transport: rpc }).getConfig();

    expect(config).toEqual({ admin: PUBLIC_KEY, treasury: TREASURY, feeBps: 250 });
  });

  it('returns null for an uninitialized contract', async () => {
    rpc.simulateTransaction.mockResolvedValue(simulationSuccess(xdr.ScVal.scvVoid()));

    await expect(makeClient({ transport: rpc }).getConfig()).resolves.toBeNull();
  });

  it('decodes claimable and vested as bigint amounts', async () => {
    const client = makeClient({ transport: rpc });

    await expect(client.claimable(7)).resolves.toBe(1_250_000_000n);
    await expect(client.vested(7)).resolves.toBe(2_500_000_000n);
  });

  it('decodes next_stream_id as a bigint without precision loss', async () => {
    // 2^53 + 1 is the first integer a JavaScript number cannot represent.
    await expect(makeClient({ transport: rpc }).nextStreamId()).resolves.toBe(
      9_007_199_254_740_993n,
    );
  });

  it('addresses the reads to the configured contract', async () => {
    const client = makeClient({ transport: rpc });
    await client.getStream(7);
    await client.nextStreamId();

    const methods = rpc.simulateTransaction.mock.calls.map(([tx]) => invokedCall(tx));
    expect(methods).toEqual([
      { contractId: CONTRACT_ID, method: 'get_stream' },
      { contractId: CONTRACT_ID, method: 'next_stream_id' },
    ]);
  });
});

describe('getVestingSummary', () => {
  let rpc: ReturnType<typeof fakeTransport>;

  beforeEach(() => {
    rpc = fakeTransport();
  });

  it('reads vested and claimable in one vesting_summary simulation as bigints', async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulationSuccess(vestingSummaryScVal(2_500_000_000n, 1_250_000_000n)),
    );

    const summary = await makeClient({ transport: rpc }).getVestingSummary(7);

    expect(summary).toEqual({ vested: 2_500_000_000n, claimable: 1_250_000_000n });
    expect(typeof summary.vested).toBe('bigint');
    expect(typeof summary.claimable).toBe('bigint');
    expect(rpc.simulateTransaction).toHaveBeenCalledTimes(1);
    const [tx] = rpc.simulateTransaction.mock.calls[0]!;
    expect(invokedCall(tx)).toEqual({ contractId: CONTRACT_ID, method: 'vesting_summary' });
    const [arg] = invokedArgs(tx);
    expect(arg!.switch()).toBe(xdr.ScValType.scvU64());
    expect(scValToNative(arg!)).toBe(7n);
  });

  it('keeps i128 amounts above 2^53 exact, matching vested and claimable', async () => {
    // 2^53 + 1 is the first integer a JavaScript number cannot represent.
    const big = 9_007_199_254_740_993n;
    rpc.simulateTransaction.mockImplementation(
      simulateByMethod({
        vesting_summary: vestingSummaryScVal(big, big - 1n),
        vested: nativeToScVal(big, { type: 'i128' }),
        claimable: nativeToScVal(big - 1n, { type: 'i128' }),
      }),
    );
    const client = makeClient({ transport: rpc });

    const summary = await client.getVestingSummary('1');

    expect(summary).toEqual({
      vested: await client.vested(1),
      claimable: await client.claimable(1),
    });
    expect(summary.vested).toBe(big);
  });

  it('surfaces a missing stream as STREAM_NOT_FOUND', async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulationError('HostError: Error(Contract, #4) stream not found'),
    );

    const error = (await makeClient({ transport: rpc })
      .getVestingSummary(99)
      .catch((e: unknown) => e)) as StreamsError;

    expect(error).toBeInstanceOf(StreamsError);
    expect(error.code).toBe('STREAM_NOT_FOUND');
    expect(error.contractCode).toBe(4);
    expect(error.message).toContain('Simulation of vesting_summary failed');
  });

  it('rejects a response that is not a VestingSummary', async () => {
    rpc.simulateTransaction.mockResolvedValue(
      simulationSuccess(nativeToScVal(1n, { type: 'i128' })),
    );

    await expect(makeClient({ transport: rpc }).getVestingSummary(1)).rejects.toThrow(
      new ContractResponseError('stream', '<response>', 'an object'),
    );
  });
});
