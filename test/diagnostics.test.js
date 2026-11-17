const test = require('node:test');
const assert = require('node:assert');
const { parseTickQuery, tpsFrom, parseLagLine, parseJfrText, summarizeProfile, ownerOf } = require('../modules/diagnostics');

test('the tick query lines of vanilla are read', () => {
  const t = parseTickQuery([
    'Target tick rate: 20.0 per second. Average time per tick: 11.4ms (Target: 50.0ms)',
    'Percentiles: P50: 11.0ms P95: 18.1ms P99: 24.0ms, sample: 100',
  ].join('\n'));
  assert.deepStrictEqual(t, { targetRate: 20, avgMs: 11.4, p50Ms: 11, p95Ms: 18.1, p99Ms: 24, sample: 100 });
  assert.strictEqual(tpsFrom(t), 20);
});

test('each tick query line works alone, and other text is ignored', () => {
  assert.deepStrictEqual(parseTickQuery('Target tick rate: 20.0 per second. Average time per tick: 80.0ms (Target: 50.0ms)'), { targetRate: 20, avgMs: 80 });
  assert.strictEqual(tpsFrom({ targetRate: 20, avgMs: 80 }), 12.5);
  assert.strictEqual(parseTickQuery('Done (4.8s)! For help, type "help"'), null);
  assert.strictEqual(tpsFrom(null), null);
});

test('a lag warning gives its delay and ticks behind', () => {
  assert.deepStrictEqual(parseLagLine("[Server thread/WARN]: Can't keep up! Is the server overloaded? Running 6720ms or 134 ticks behind"), { delayMs: 6720, ticksBehind: 134 });
  assert.strictEqual(parseLagLine('Saving chunks'), null);
});

const SAMPLE = `jdk.ExecutionSample {
  startTime = 18:56:07.119 (2026-11-17)
  sampledThread = "Server thread" (javaThreadId = 51)
  state = "STATE_RUNNABLE"
  stackTrace = [
    net.minecraft.world.level.levelgen.DensityFunctions$Mul.compute(DensityFunction$FunctionContext) line: 12
    dev.hexedmaya.meowhehemeow.worldgen.IslandClimate.compute(DensityFunction$FunctionContext) line: 55
    net.minecraft.server.MinecraftServer.tickServer(BooleanSupplier) line: 700
    ...
  ]
}

jdk.ExecutionSample {
  startTime = 18:56:07.129 (2026-11-17)
  sampledThread = "Server thread" (javaThreadId = 51)
  state = "STATE_RUNNABLE"
  stackTrace = [
    net.minecraft.world.level.levelgen.DensityFunctions$Mul.compute(DensityFunction$FunctionContext) line: 12
    dev.hexedmaya.meowhehemeow.worldgen.IslandClimate.compute(DensityFunction$FunctionContext) line: 55
  ]
}

jdk.ExecutionSample {
  startTime = 18:56:07.139 (2026-11-17)
  sampledThread = "Worker-Main-7" (javaThreadId = 61)
  state = "STATE_RUNNABLE"
  stackTrace = [
    java.util.HashMap.get(Object) line: 100
    net.minecraft.world.level.chunk.ChunkAccess.getBlockState(BlockPos) line: 20
  ]
}

jdk.ExecutionSample {
  startTime = 18:56:07.149 (2026-11-17)
  sampledThread = "Worker-Main-9" (javaThreadId = 62)
  state = "STATE_RUNNABLE"
  stackTrace = [
    java.util.HashMap.get(Object) line: 100
    com.example.shiny.Mod.onTick(Level) line: 9
  ]
}

jdk.GarbageCollection {
  startTime = 18:56:07.335 (2026-11-17)
  duration = 4.45 ms
  gcId = 0
  name = "G1New"
  cause = "G1 Evacuation Pause"
  sumOfPauses = 4.45 ms
  longestPause = 4.45 ms
  eventThread = "VM Thread" (osThreadId = 57636)
}

jdk.GarbageCollection {
  startTime = 18:56:08.335 (2026-11-17)
  duration = 1.2 s
  gcId = 1
  name = "G1Old"
  sumOfPauses = 1.2 s
  longestPause = 1.2 s
}
`;

test('a jfr dump is read into samples with thread, frames and the GC pauses', () => {
  const parsed = parseJfrText(SAMPLE);
  assert.strictEqual(parsed.samples.length, 4);
  assert.strictEqual(parsed.samples[0].thread, 'Server thread');
  assert.strictEqual(parsed.samples[0].frames.length, 3);
  assert.deepStrictEqual(parsed.gc, { count: 2, totalPauseMs: 1204.5, longestMs: 1200 });
});

test('the time is attributed to the mod, with Minecraft and the JDK as their own owners', () => {
  assert.strictEqual(ownerOf(['net.minecraft.A.b() line: 1', 'dev.hexedmaya.meowhehemeow.worldgen.X.y() line: 2']), 'dev.hexedmaya.meowhehemeow');
  assert.strictEqual(ownerOf(['com.example.shiny.Mod.onTick(Level) line: 9']), 'com.example.shiny');
  assert.strictEqual(ownerOf(['java.util.HashMap.get(Object) line: 1', 'net.minecraft.A.b() line: 2']), 'Minecraft');
  assert.strictEqual(ownerOf(['java.util.HashMap.get(Object) line: 1']), 'JDK / runtime');
});

test('the summary ranks the server thread methods, owners and thread groups', () => {
  const s = summarizeProfile(parseJfrText(SAMPLE), { durationSec: 10 });
  assert.strictEqual(s.samples, 4);
  assert.strictEqual(s.durationSec, 10);
  assert.deepStrictEqual(s.serverThread.methods[0], { name: 'net.minecraft.world.level.levelgen.DensityFunctions$Mul.compute', samples: 2, percent: 100 });
  assert.strictEqual(s.serverThread.owners[0].name, 'dev.hexedmaya.meowhehemeow');
  assert.deepStrictEqual(s.threads.map((x) => [x.name, x.samples]), [['Server thread', 2], ['Worker-Main-N', 2]]);
  assert.ok(s.owners.some((o) => o.name === 'com.example.shiny'));
});

test('an empty recording gives an empty summary instead of an error', () => {
  const s = summarizeProfile(parseJfrText(''));
  assert.strictEqual(s.samples, 0);
  assert.strictEqual(s.serverThread, null);
  assert.deepStrictEqual(s.threads, []);
});
