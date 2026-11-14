import flash.display.BitmapData;
import flash.display.DisplayObject;
import flash.display.DisplayObjectContainer;
import flash.display.Loader;
import flash.display.MovieClip;
import flash.display.Sprite;
import flash.events.Event;
import flash.events.IOErrorEvent;
import flash.events.SecurityErrorEvent;
import flash.events.UncaughtErrorEvent;
import flash.geom.Matrix;
import flash.net.URLLoader;
import flash.net.URLLoaderDataFormat;
import flash.net.URLRequest;
import flash.net.URLRequestMethod;
import flash.system.ApplicationDomain;
import flash.system.LoaderContext;
import flash.utils.ByteArray;
import flash.utils.Dictionary;

/**
 * Capture wrapper, run inside Ruffle by export.mjs.
 *
 * Loads a Seer pet fight-animation SWF, instantiates its exported `pet` class and, like
 * Petdoctor's FightPanel, plays every frame label (attack / sa / cp / hited / appear ...):
 *     pet.gotoAndStop(label); next frame: pet.getChildAt(0).gotoAndPlay(1)
 * Each rendered frame is drawn with BitmapData.draw (frame scripts, nested clips, filters and
 * blend modes behave as in the game) and POSTed back as zlib-compressed ARGB.
 * Optionally also plays exported effect classes (FlashVar `classes`).
 *
 * FlashVars: swf, post, scale, pad, labels, classes, bg, maxFrames, maxSize, debug
 */
class Exporter {
	static var root:MovieClip;
	static var post:String;
	static var scale:Float = 1;
	static var pad:Float = 64;
	static var maxFrames:Int = 3000;
	static var maxSize:Int = 4096;
	static var debug:Bool = false;
	static var bg:Int = -1; // -1: transparent, else opaque 0xRRGGBB background

	static var domain:ApplicationDomain;
	static var holder:Sprite;
	static var pet:MovieClip;
	static var jobs:Array<Job> = [];
	static var job:Job;
	static var jobIndex:Int = -1;
	static var state:Int = 0; // 0 next job, 1 start, 2 capturing, 3 wait for uploads, 4 finished
	static var subject:DisplayObject; // what gets drawn (the pet, or an effect instance)
	static var action:MovieClip; // the timeline that drives the sequence
	static var seq:Int = 0;
	static var lastFrame:Int = -1;
	static var stall:Int = 0;
	static var pending:Int = 0;
	static var inTick:Bool = false;
	static var seen:Dictionary; // MovieClip -> true once it has finished one pass
	// capture taken right after gotoAndPlay(1); held back one tick because the player can show
	// frame 1 for one more tick (then the later capture replaces it, so frame 1 is not doubled)
	static var held:Capture;

	static function main() {
		root = flash.Lib.current;
		var p:Dynamic = root.loaderInfo.parameters;
		post = param(p, "post", "/api");
		scale = Std.parseFloat(param(p, "scale", "1"));
		pad = Std.parseFloat(param(p, "pad", "64"));
		maxFrames = Std.parseInt(param(p, "maxFrames", "3000"));
		maxSize = Std.parseInt(param(p, "maxSize", "4096"));
		debug = param(p, "debug", "") != "";
		var bgs = param(p, "bg", "");
		if (bgs != "")
			bg = Std.parseInt("0x" + bgs);
		var labels = list(param(p, "labels", ""));
		var classes = list(param(p, "classes", ""));
		root.loaderInfo.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);

		var loader = new Loader();
		loader.uncaughtErrorEvents.addEventListener(UncaughtErrorEvent.UNCAUGHT_ERROR, onUncaught);
		loader.contentLoaderInfo.addEventListener(Event.COMPLETE, function(_) onLoaded(loader, labels, classes));
		loader.contentLoaderInfo.addEventListener(IOErrorEvent.IO_ERROR, function(e) fail("cannot load pet swf: " + e));
		loader.load(new URLRequest(param(p, "swf", "pet.swf")), new LoaderContext(false, new ApplicationDomain()));
	}

	static function param(p:Dynamic, k:String, d:String):String {
		var v:Dynamic = Reflect.field(p, k);
		return v == null || v == "" ? d : Std.string(v);
	}

	static function list(s:String):Array<String> {
		return s == "" ? null : s.split(",");
	}

	static function onUncaught(e:UncaughtErrorEvent) {
		e.preventDefault();
		log("uncaught script error in pet swf: " + Std.string(e.error));
	}

	static function onLoaded(loader:Loader, labels:Array<String>, classes:Array<String>) {
		var info = loader.contentLoaderInfo;
		domain = info.applicationDomain;
		holder = new Sprite();
		holder.x = 400;
		holder.y = 400;
		root.addChild(holder);

		var labelJson = [];
		if (domain.hasDefinition("pet")) {
			pet = cast Type.createInstance(domain.getDefinition("pet"), []);
			pet.stop();
			for (fl in pet.currentLabels) {
				labelJson.push('{"name":${quote(fl.name)},"frame":${fl.frame}}');
				if (labels == null || labels.indexOf(fl.name) >= 0)
					jobs.push({name: fl.name, frame: fl.frame, cls: null});
			}
		} else if (classes == null) {
			fail("this swf has no exported `pet` class (not a fight animation?)");
			return;
		}
		if (classes != null)
			for (c in classes)
				if (domain.hasDefinition(c))
					jobs.push({name: c, frame: 0, cls: c});
		var meta = '{"fps":${info.frameRate},"swfVersion":${info.swfVersion},"petTotalFrames":${pet == null ? 0 : pet.totalFrames},'
			+ '"stageWidth":${info.width},"stageHeight":${info.height},"scale":$scale,"labels":[${labelJson.join(",")}]}';
		send("/meta", stringBytes(meta));
		root.addEventListener(Event.EXIT_FRAME, tick);
	}

	static function tick(_) {
		// A scripted goto (gotoAndStop/gotoAndPlay) dispatches a nested exitFrame broadcast,
		// which would re-enter this handler and recurse until the stack overflows.
		if (inTick)
			return;
		inTick = true;
		try {
			step();
		} catch (e:Dynamic) {
			log("error at " + (job == null ? "?" : job.name) + " #" + seq + ": " + Std.string(e));
			if (job != null && state != 0)
				endJob();
		}
		inTick = false;
	}

	static function step() {
		switch (state) {
			case 0:
				jobIndex++;
				if (jobIndex >= jobs.length) {
					state = 3;
					return;
				}
				job = jobs[jobIndex];
				while (holder.numChildren > 0)
					holder.removeChildAt(0);
				if (job.cls == null) {
					holder.addChild(pet);
					pet.gotoAndStop(job.frame);
					subject = pet;
				} else {
					// linkage classes can also be sounds or BitmapData: only display objects are played
					var o:Dynamic = null;
					try {
						o = Type.createInstance(domain.getDefinition(job.cls), []);
					} catch (e:Dynamic) {}
					if (!Std.isOfType(o, DisplayObject))
						return; // state stays 0: next job on the next tick
					subject = cast o;
					holder.addChild(subject);
				}
				if (debug)
					dlog("job " + job.name);
				state = 1;
			case 1:
				action = job.cls == null ? findAction() : (Std.isOfType(subject, MovieClip) ? cast subject : null);
				seq = 0;
				lastFrame = -1;
				stall = 0;
				seen = new Dictionary(true);
				held = null;
				if (action == null) {
					// static frame without a timeline: capture it once
					emit(capture(1, 1, null));
					endJob();
					return;
				}
				action.gotoAndPlay(1);
				state = 2;
				held = capture(action.currentFrame, action.totalFrames, hitOf(action));
				lastFrame = held.cf;
			case 2:
				if (held != null) {
					if (action.currentFrame != held.cf || action.totalFrames == 1)
						emit(held);
					else
						lastFrame = -1; // frame 1 shown again: the early capture is dropped
					held = null;
				}
				captureAction();
			case 3:
				if (pending == 0) {
					state = 4;
					root.removeEventListener(Event.EXIT_FRAME, tick);
					send("/done", stringBytes("{}"));
				}
		}
	}

	static function findAction():MovieClip {
		for (i in 0...pet.numChildren) {
			var d = pet.getChildAt(i);
			if (Std.isOfType(d, MovieClip))
				return cast d;
		}
		return null;
	}

	static function captureAction() {
		var cf = action.currentFrame;
		stall = cf == lastFrame ? stall + 1 : 0;
		var nestedDone = nestedFinished(action); // evaluated every tick so first passes are tracked
		// The playhead stopped (stop() before the end, or a 1-frame container): keep going while
		// nested clips are still on their first pass, then end without repeating the frozen frame.
		if (stall >= 1 && (nestedDone || stall > 240)) {
			endJob();
			return;
		}
		emit(capture(cf, action.totalFrames, hitOf(action)));
		lastFrame = cf;
		// like the game: an action is over once its own timeline reaches the last frame
		if ((cf >= action.totalFrames && action.totalFrames > 1) || seq >= maxFrames)
			endJob();
	}

	/** true when every MovieClip under `root` has finished (or stopped) its first pass */
	static function nestedFinished(top:MovieClip):Bool {
		var all = true;
		var stack:Array<DisplayObject> = [];
		for (i in 0...top.numChildren)
			stack.push(top.getChildAt(i));
		while (stack.length > 0) {
			var d = stack.pop();
			if (Std.isOfType(d, MovieClip)) {
				var m:MovieClip = cast d;
				if (m.totalFrames > 1 && untyped seen[m] != true) {
					if (m.currentFrame >= m.totalFrames || !m.isPlaying)
						untyped seen[m] = true;
					else
						all = false;
				}
			}
			if (Std.isOfType(d, DisplayObjectContainer)) {
				var c:DisplayObjectContainer = cast d;
				for (i in 0...c.numChildren)
					stack.push(c.getChildAt(i));
			}
		}
		return all;
	}

	static function endJob() {
		send("/end?label=" + StringTools.urlEncode(job.name) + "&frames=" + seq + "&kind=" + (job.cls == null ? "label" : "class"),
			stringBytes("{}"));
		if (action != null)
			action.stop();
		held = null;
		state = 0;
	}

	static function hitOf(mc:MovieClip):Dynamic {
		try {
			return Reflect.field(mc, "hit");
		} catch (e:Dynamic) {
			return null;
		}
	}

	static function emit(c:Capture) {
		seq++;
		send("/frame?seq=" + seq + "&" + c.q, c.px);
	}

	static function capture(cf:Int, total:Int, hit:Dynamic):Capture {
		var r = subject.getBounds(holder);
		var q = "label=" + StringTools.urlEncode(job.name) + "&cf=" + cf + "&total=" + total + "&hit=" + StringTools.urlEncode(Std.string(hit));
		if (r.width <= 0 || r.height <= 0) {
			// nothing visible (e.g. the pet dashed off-screen): an empty frame. The body must not be
			// empty, because a POST without a body is sent as a GET.
			var empty = new ByteArray();
			empty.writeByte(0);
			return {q: q + "&x=0&y=0&w=0&h=0", px: empty, cf: cf};
		}
		var x0 = Math.floor((r.x - pad) * scale);
		var y0 = Math.floor((r.y - pad) * scale);
		var w = Math.ceil((r.x + r.width + pad) * scale) - x0;
		var h = Math.ceil((r.y + r.height + pad) * scale) - y0;
		// keep huge (e.g. full-screen effect) frames within texture limits, centred on the pet origin
		if (w > maxSize) {
			x0 = Std.int(Math.max(x0, -maxSize / 2));
			w = maxSize;
		}
		if (h > maxSize) {
			y0 = Std.int(Math.max(y0, -maxSize / 2));
			h = maxSize;
		}
		var bmp = bg < 0 ? new BitmapData(w, h, true, 0) : new BitmapData(w, h, false, bg);
		bmp.draw(holder, new Matrix(scale, 0, 0, scale, -x0, -y0), null, null, null, true);
		var px = bmp.getPixels(bmp.rect);
		bmp.dispose();
		px.compress();
		return {q: q + "&x=" + x0 + "&y=" + y0 + "&w=" + w + "&h=" + h, px: px, cf: cf};
	}

	static function send(path:String, data:ByteArray) {
		var req = new URLRequest(post + path);
		req.method = URLRequestMethod.POST;
		req.contentType = "application/octet-stream";
		req.data = data;
		var ul = new URLLoader();
		ul.dataFormat = URLLoaderDataFormat.BINARY;
		pending++;
		ul.addEventListener(Event.COMPLETE, function(_) pending--);
		ul.addEventListener(IOErrorEvent.IO_ERROR, function(_) pending--);
		ul.addEventListener(SecurityErrorEvent.SECURITY_ERROR, function(_) pending--);
		ul.load(req);
	}

	static function stringBytes(s:String):ByteArray {
		var b = new ByteArray();
		b.writeUTFBytes(s);
		return b;
	}

	static function quote(s:String):String {
		return '"' + StringTools.replace(StringTools.replace(s, "\\", "\\\\"), '"', '\\"') + '"';
	}

	static function dlog(msg:String) {
		flash.external.ExternalInterface.call("console.log", "[exporter] " + StringTools.urlEncode(msg));
	}

	static function log(msg:String) {
		send("/log", stringBytes(msg));
	}

	static function fail(msg:String) {
		send("/fail", stringBytes(msg));
	}
}

typedef Job = {name:String, frame:Int, cls:Null<String>};
typedef Capture = {q:String, px:ByteArray, cf:Int};
