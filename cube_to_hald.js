// cube_to_hald.js
//
// Converts a .cube 3D LUT into a standard Hald CLUT PNG (raster-packed:
// red fastest, then green, then blue, wrapping across a level^3-wide
// square image). Use with lut_apply_hald.jxs.
//
// Setup (once, in this file's folder):
//   npm install pngjs
//
// Max side:
//   [node.script cube_to_hald.js]
//   send it a message:  convert <input.cube> [output.png] [forceLevel]
//   (wrap paths in quotes if they contain spaces)
//
// If the .cube's LUT_3D_SIZE isn't a perfect square (e.g. 32, 33 -- very
// common export sizes that aren't valid Hald sizes), it's automatically
// trilinearly resampled to level 8 (64^3, the Hald standard) before being
// written. Pass forceLevel to resample to a specific level instead/always.
//
// Outputs on completion: outlet fires  done <outputPath> <width> <level>
// On error: outlet fires  error <message>

const maxApi = require("max-api");
const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");

function parseCube(inputPath) {
	const text = fs.readFileSync(inputPath, "utf8");
	let size = null;
	const data = [];

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const sizeMatch = line.match(/^LUT_3D_SIZE\s+(\d+)/i);
		if (sizeMatch) {
			size = parseInt(sizeMatch[1], 10);
			continue;
		}
		if (/^[A-Za-z]/.test(line)) {
			// other header keywords (TITLE, DOMAIN_MIN, DOMAIN_MAX, LUT_1D_SIZE, etc.)
			continue;
		}
		const parts = line.split(/\s+/).map(Number);
		if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
			data.push(parts);
		}
	}

	if (size === null) {
		throw new Error("No LUT_3D_SIZE found in .cube file");
	}
	const expected = size * size * size;
	if (data.length !== expected) {
		throw new Error(`Expected ${expected} rows for LUT_3D_SIZE ${size}, got ${data.length}`);
	}
	return { size, data };
}

function clamp255(v) {
	return Math.max(0, Math.min(255, Math.round(v * 255)));
}

// Trilinearly sample the source cube at a continuous (r,g,b) coordinate,
// each in [0, size-1]. Used to resample onto a different grid size.
function sampleCubeTrilinear(data, size, r, g, b) {
	const r0 = Math.floor(r), g0 = Math.floor(g), b0 = Math.floor(b);
	const r1 = Math.min(r0 + 1, size - 1);
	const g1 = Math.min(g0 + 1, size - 1);
	const b1 = Math.min(b0 + 1, size - 1);
	const fr = r - r0, fg = g - g0, fb = b - b0;

	const at = (ri, gi, bi) => data[ri + gi * size + bi * size * size];
	const lerp3 = (a, c, t) => [
		a[0] + (c[0] - a[0]) * t,
		a[1] + (c[1] - a[1]) * t,
		a[2] + (c[2] - a[2]) * t,
	];

	const c00 = lerp3(at(r0, g0, b0), at(r1, g0, b0), fr);
	const c10 = lerp3(at(r0, g1, b0), at(r1, g1, b0), fr);
	const c01 = lerp3(at(r0, g0, b1), at(r1, g0, b1), fr);
	const c11 = lerp3(at(r0, g1, b1), at(r1, g1, b1), fr);
	const c0 = lerp3(c00, c10, fg);
	const c1 = lerp3(c01, c11, fg);
	return lerp3(c0, c1, fb);
}

// Resample a size^3 cube up/down to targetSize^3 via trilinear interpolation.
function resampleCube(size, data, targetSize) {
	const out = new Array(targetSize * targetSize * targetSize);
	const scale = (size - 1) / (targetSize - 1);
	for (let b = 0; b < targetSize; b++) {
		for (let g = 0; g < targetSize; g++) {
			for (let r = 0; r < targetSize; r++) {
				const idx = r + g * targetSize + b * targetSize * targetSize;
				out[idx] = sampleCubeTrilinear(data, size, r * scale, g * scale, b * scale);
			}
		}
	}
	return out;
}

function buildHaldPNG(size, data, forceLevel) {
	let level = Math.sqrt(size);

	if (forceLevel || !Number.isInteger(level)) {
		const targetLevel = forceLevel || 8; // level 8 == 64^3, the standard size
		const targetSize = targetLevel * targetLevel;
		maxApi.post(
			`cube_to_hald: resampling ${size}^3 -> ${targetSize}^3 (level ${targetLevel}) via trilinear interpolation`
		);
		data = resampleCube(size, data, targetSize);
		size = targetSize;
		level = targetLevel;
	}

	const width = size * level; // == level^3
	const png = new PNG({ width, height: width, colorType: 6 }); // RGBA

	// .cube rows are ordered red-fastest, then green, then blue:
	// cubeIndex = r + g*size + b*size*size
	for (let b = 0; b < size; b++) {
		for (let g = 0; g < size; g++) {
			for (let r = 0; r < size; r++) {
				const cubeIndex = r + g * size + b * size * size;
				const [rr, gg, bb] = data[cubeIndex];

				// Hald raster packing: flat index i = b*size*size + g*size + r,
				// laid left-to-right/top-to-bottom across a `width`-wide image.
				const i = b * size * size + g * size + r;
				const x = i % width;
				const y = Math.floor(i / width);
				const idx = (width * y + x) << 2;

				png.data[idx] = clamp255(rr);
				png.data[idx + 1] = clamp255(gg);
				png.data[idx + 2] = clamp255(bb);
				png.data[idx + 3] = 255;
			}
		}
	}

	return { png, width, level };
}

function writePNG(png, outputPath) {
	return new Promise((resolve, reject) => {
		const stream = fs.createWriteStream(outputPath);
		png.pack().pipe(stream);
		stream.on("finish", resolve);
		stream.on("error", reject);
	});
}

function defaultOutputPath(inputPath) {
	return inputPath.replace(/\.cube$/i, "") + "_hald.png";
}

// If outputPath points at an existing directory, write "output.png" inside
// it instead of treating the directory itself as the target file.
function resolveOutputPath(outputPath, inputPath) {
	if (!outputPath) return defaultOutputPath(inputPath);
	try {
		if (fs.statSync(outputPath).isDirectory()) {
			return path.join(outputPath, "output.png");
		}
	} catch (err) {
		// doesn't exist (or isn't statable) -- treat it as a literal file path
	}
	return outputPath;
}

// Max sometimes hands node.script a path with a legacy HFS volume prefix
// stuck on the front, e.g. "Macintosh HD:/Users/c/foo.cube" (mixed) or
// "Macintosh HD:Users:c:foo.cube" (full classic colon path). Node's fs
// only understands plain POSIX paths, so strip the volume prefix off.
function normalizeMacPath(p) {
	if (!p) return p;
	if (p.startsWith("/")) return p; // already POSIX

	const mixedMatch = p.match(/^[^:/]+:(\/.*)$/);
	if (mixedMatch) return mixedMatch[1];

	if (p.includes(":")) {
		const parts = p.split(":");
		parts.shift(); // drop the volume name
		return "/" + parts.join("/");
	}

	return p;
}

async function convert(inputPath, outputPath, forceLevel) {
	const { size, data } = parseCube(inputPath);
	const { png, width, level } = buildHaldPNG(size, data, forceLevel);
	await writePNG(png, outputPath);
	return { width, level, size };
}

maxApi.addHandler("convert", async (inputPathRaw, outputPathRaw, forceLevelRaw) => {
	const inputPath = normalizeMacPath(inputPathRaw);
	const resolvedOutput = resolveOutputPath(normalizeMacPath(outputPathRaw), inputPath);
	const forceLevel = forceLevelRaw ? parseInt(forceLevelRaw, 10) : undefined;
	try {
		const { width, level, size } = await convert(inputPath, resolvedOutput, forceLevel);
		maxApi.post(`cube_to_hald: wrote ${resolvedOutput} -- ${width}x${width}, level ${level} (${size} samples/channel)`);
		maxApi.outlet("done", resolvedOutput, width, level);
	} catch (err) {
		maxApi.post(`cube_to_hald error: ${err.message}`, maxApi.POST_LEVELS.ERROR);
		maxApi.outlet("error", err.message);
	}
});

maxApi.post("cube_to_hald.js ready -- send: convert <input.cube> [output.png]");
