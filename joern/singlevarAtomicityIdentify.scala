// ════════════════════════════════════════════════════════════════════════════
// singlevarAtomicityIdentify.scala
//
// Stage 1 of single-variable atomicity violation detection (intAtom-style).
//
// Reads parameters from JSON via --param paramsPath=<path>, runs Joern queries,
// emits:
//   - singlevar-pairs.json:      ConsecutiveLocalPair[]
//   - singlevar-candidates.json: SinglevarViolationCandidate[]
//   - singlevar-candidates.md:   Markdown summary
//
// Companion: src/tools/singlevar-pattern-detect.ts (TS invoker)
// Companion: src/schema/singlevar-atomicity.ts    (output schema)
//
// Phase 1 implementation: validated against EmbedSVABench L1_004/L1_005/L1_006.
// Phase 1 deliberately limits scope to:
//   - Same-function consecutive access pair finding (no cross-function relaxation;
//     that comes in Phase 3)
//   - Alias normalization for EXACT and STRUCT_FIELD (POINTER_DEREF/MMIO in Phase 3)
//   - No loop bound inference (Phase 4)
//   - No Stage 2 path-mutex filtering (Stage 2 is the agent's job + LLM)
// ════════════════════════════════════════════════════════════════════════════

import _root_.io.shiftleft.codepropertygraph.generated.{help as _, *}
import _root_.io.shiftleft.semanticcpg.language.*
import _root_.io.shiftleft.semanticcpg.language.NoResolve
import _root_.io.shiftleft.codepropertygraph.generated.nodes.*
import _root_.io.joern.joerncli.console.JoernConsole.*
import _root_.io.joern.joerncli.console.Joern.{cpg, *}
import io.joern.x2cpg.X2Cpg.applyDefaultOverlays
import ujson.{Arr, Obj, Value}

import java.nio.charset.StandardCharsets
import java.nio.file.{Files, Paths}
import scala.collection.mutable
import scala.io.Source
import scala.util.{Failure, Success, Try}

implicit val resolver: ICallResolver = NoResolve

// ── Assignment operators (Joern's <operator>.assignment* names) ──
val ASSIGN_OPS: Set[String] = Set(
  "<operator>.assignment", "<operators>.assignment",
  "<operator>.assignmentPlus", "<operator>.assignmentMinus",
  "<operator>.assignmentMultiplication", "<operator>.assignmentDivision",
  "<operator>.assignmentModulo",
  "<operator>.assignmentAnd", "<operator>.assignmentOr", "<operator>.assignmentXor",
  "<operator>.assignmentShiftLeft", "<operator>.assignmentArithmeticShiftRight",
  "<operator>.assignmentLogicalShiftRight",
  "<operator>.postDecrement", "<operator>.postIncrement",
  "<operator>.preDecrement", "<operator>.preIncrement",
)

// RMW ops (matter for confidence scoring: rmw_op +0.08)
val RMW_OPS: Set[String] = Set(
  "<operator>.assignmentPlus", "<operator>.assignmentMinus",
  "<operator>.assignmentMultiplication", "<operator>.assignmentDivision",
  "<operator>.assignmentAnd", "<operator>.assignmentOr", "<operator>.assignmentXor",
  "<operator>.assignmentShiftLeft", "<operator>.assignmentArithmeticShiftRight",
  "<operator>.assignmentLogicalShiftRight",
  "<operator>.postDecrement", "<operator>.postIncrement",
  "<operator>.preDecrement", "<operator>.preIncrement",
)

// ──────────────────────────────────────────────────────────────────────────────
// Parameter parsing
// ──────────────────────────────────────────────────────────────────────────────

case class SvaParams(
  cpgPath: String,
  projectName: String,
  taskEntries: List[String],
  isrEntries: List[String],
  interruptPriorities: Map[String, Int],
  maxCallChainDepth: Int,
  outputPath: String,
  pairsOutputPath: String,
  mdOutputPath: String,
)

object SvaParamLoader {
  def load(paramsPath: String): SvaParams = {
    val src = Source.fromFile(paramsPath, "UTF-8")
    val text = try src.mkString finally src.close()
    val j = ujson.read(text)
    SvaParams(
      cpgPath              = j("cpg_path").str,
      projectName          = j("project_name").str,
      taskEntries          = j("task_entries").arr.map(_.str).toList,
      isrEntries           = j("isr_entries").arr.map(_.str).toList,
      interruptPriorities  = j("interrupt_priorities").obj.map { case (k, v) => k -> v.num.toInt }.toMap,
      maxCallChainDepth    = j("max_call_chain_depth").num.toInt,
      outputPath           = j("output_path").str,
      pairsOutputPath      = j("pairs_output_path").str,
      mdOutputPath         = j("md_output_path").str,
    )
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Output data structures (mirror src/schema/singlevar-atomicity.ts)
// ──────────────────────────────────────────────────────────────────────────────

case class SourceLoc(
  filePath: String, line: Int, column: Int, function: String, code: String
)

case class VarAccess(
  variableName: String, accessType: String,
  location: SourceLoc, entryFunction: String, expression: String, role: String
)

case class AliasNorm(
  originalExpression: String, canonicalName: String,
  rule: String, confidence: Double, note: Option[String]
)

case class CrossFn(
  callChain: List[String], depth: Int,
  hasInterruptStateChange: Boolean, hasYieldCall: Boolean, hasSpinWait: Boolean,
  confidenceMultiplier: Double
)

case class Pair(
  id: String, variableName: String, canonicalVar: String,
  local1: VarAccess, local2: VarAccess,
  sameFunction: Boolean, crossFunction: Option[CrossFn],
)

case class Remote(isrName: String, priority: Int, access: VarAccess, canonicalVar: String)

case class Candidate(
  id: String, pattern: String,
  variableName: String, canonicalVar: String,
  aliasInfo: Option[AliasNorm],
  consecutivePairId: String,
  local1: VarAccess, remote: VarAccess, local2: VarAccess,
  remoteIsr: Remote,
  loopContexts: List[ujson.Value],
  crossFunction: Option[CrossFn],
  structuralScore: Double,
  evidenceBreakdown: Map[String, Double],
)

// ──────────────────────────────────────────────────────────────────────────────
// Joern helpers
// ──────────────────────────────────────────────────────────────────────────────

def isUserMethod(m: Method): Boolean = {
  m.filterNot(_.isExternal)
   .filterNot(_.name.endsWith(">"))
   .filterNot(mm => mm.code == "<empty>" || (mm.code.startsWith("extern ") && mm.code.endsWith(";")))
   .headOption.nonEmpty
}

def isGlobalLocal(l: Local): Boolean = {
  l.method.name.contains("<global>") && l.typeFullName != "struct"
}

/** All global variables in the CPG (name list, deduplicated). */
def allGlobalVars(): Set[String] = {
  cpg.local.filter(isGlobalLocal).name.toSet
}

/**
 * Determine access type by walking up the AST.
 * Handles direct assignment LHS, post/pre inc/dec, indirect access on LHS.
 */
def determineAccessType(node: StoredNode, maxDepth: Int = 8): String = {
  def walk(cur: StoredNode, depth: Int): String = {
    if (depth <= 0) return "READ"
    cur._astIn.nextOption match {
      case Some(parent: Call) =>
        val name = parent.name
        if (ASSIGN_OPS.exists(op => name == op || name.startsWith(op))) {
          Try(parent.argument(1)).toOption match {
            case Some(lhs) if lhs == cur => "WRITE"
            case _ => "READ"
          }
        } else if (name == Operators.addressOf) {
          // &x: conservative WRITE — &x is typically passed to a function that
          // may mutate *x. Phase 1 accepts this over-approximation; Phase 3 will
          // use callee analysis to refine (only WRITE if the callee writes through
          // the pointer parameter).
          "WRITE"
        } else if (
          name == Operators.fieldAccess || name == Operators.indirectFieldAccess ||
          name == Operators.indexAccess || name == Operators.indirectIndexAccess ||
          name == Operators.indirection || name == Operators.cast
        ) {
          walk(parent, depth - 1)
        } else {
          "READ"
        }
      case Some(parent: StoredNode) if !parent.isInstanceOf[Method] =>
        walk(parent, depth - 1)
      case _ => "READ"
    }
  }
  walk(node, maxDepth)
}

/** Build the canonical form for an access expression. */
def canonicalize(expr: Expression, globalRoots: Set[String]): Option[AliasNorm] = {
  expr match {
    case id: Identifier if globalRoots.contains(id.name) =>
      Some(AliasNorm(id.name, id.name, "EXACT", 1.0, None))
    case call: Call if call.name == Operators.fieldAccess =>
      // a.b — direct field access
      val base = Try(call.argument(1)).toOption
      val field = Try(call.argument(2).asInstanceOf[FieldIdentifier]).toOption
      (base, field) match {
        case (Some(b: Identifier), Some(f)) if globalRoots.contains(b.name) =>
          val canon = s"${b.name}.${f.canonicalName}"
          Some(AliasNorm(call.code, canon, "STRUCT_FIELD", 1.0, None))
        case (Some(b: Call), Some(f)) =>
          // nested: a.b.c → recurse
          canonicalize(b, globalRoots).map { inner =>
            val canon = s"${inner.canonicalName}.${f.canonicalName}"
            AliasNorm(call.code, canon, "STRUCT_FIELD", inner.confidence, None)
          }
        case _ => None
      }
    case call: Call if call.name == Operators.indirectFieldAccess =>
      // a->b
      val base = Try(call.argument(1)).toOption
      val field = Try(call.argument(2).asInstanceOf[FieldIdentifier]).toOption
      (base, field) match {
        case (Some(b: Identifier), Some(f)) if globalRoots.contains(b.name) =>
          val canon = s"${b.name}->${f.canonicalName}"
          Some(AliasNorm(call.code, canon, "STRUCT_FIELD", 1.0, None))
        case _ => None
      }
    case call: Call if call.name == Operators.indexAccess || call.name == Operators.indirectIndexAccess =>
      // arr[i]
      val base = Try(call.argument(1)).toOption
      val idx = Try(call.argument(2)).toOption
      (base, idx) match {
        case (Some(b: Identifier), Some(idxExpr)) if globalRoots.contains(b.name) =>
          idxExpr match {
            case lit: Literal =>
              Some(AliasNorm(call.code, s"${b.name}[${lit.code}]", "ARRAY_ELEMENT_FIXED", 1.0, None))
            case _ =>
              // symbolic index — conservative: same array
              Some(AliasNorm(call.code, s"${b.name}[*]", "ARRAY_ELEMENT_SYMBOLIC", 0.7,
                Some("array index symbolic — over-approximated")))
          }
        case _ => None
      }
    case _ => None
  }
}

/** Source location helpers. CfgNode subclasses (Expression/Identifier/Call) have
 *  the .method and .file extensions; plain AstNode does not. */
def safeLine(n: AstNode): Int = n.lineNumber.map(_.intValue()).getOrElse(-1)
def safeCol(n: AstNode): Int = n.columnNumber.map(_.intValue()).getOrElse(0)
def safeFile(n: AstNode): String = n match {
  case c: CfgNode => Try(c.file.name.headOption.getOrElse("")).getOrElse("")
  case _ => ""
}
def enclosingFunc(n: AstNode): String = n match {
  case c: CfgNode => Try(c.method.name).getOrElse("")
  case _ => ""
}
def codeOf(n: AstNode): String = Try(n.code).getOrElse("")

/**
 * Returns true when this Identifier is the base of a struct/array access
 * (e.g., the `Obdh` in `Obdh.DeltB`, or the `arr` in `arr[i]`). Such an
 * identifier should NOT be counted as an independent access to the base
 * variable — the full canonical form (Obdh.DeltB or arr[i]) is the access.
 */
def isBaseOfMemberAccess(id: Identifier): Boolean = {
  id._astIn.nextOption match {
    case Some(parent: Call) =>
      val name = parent.name
      val isAccessor = name == Operators.fieldAccess ||
                       name == Operators.indirectFieldAccess ||
                       name == Operators.indexAccess ||
                       name == Operators.indirectIndexAccess ||
                       name == Operators.indirection
      if (!isAccessor) return false
      // The Identifier is the "base" iff it is argument(1) of the accessor.
      Try(parent.argument(1)).toOption.contains(id)
    case _ => false
  }
}

/**
 * Returns true when this node is passed by address (`&x` or `&s.f`) into a
 * function call. Such an access is conservatively treated as a (READ, WRITE)
 * RMW pair: the caller can't statically know whether the callee reads, writes,
 * or both — assuming both is the soundest local approximation when no
 * callee-side flow analysis is available.
 *
 * Phase 3 refinement (`addressOf` callee-sensitive analysis): a more precise
 * implementation would inspect the callee's parameter to see if it's actually
 * written, read, or both. Phase 3 here uses the simpler "assume RMW" rule,
 * which is sound but over-approximating (may generate FPs for read-only callees).
 */
def isAddressOfPassedToCall(node: Expression): Boolean = {
  // The enclosing chain we accept: node → ... → addressOf → (cast?) → callArgument
  def walk(cur: StoredNode, sawAddressOf: Boolean, depth: Int): Boolean = {
    if (depth <= 0) return false
    cur._astIn.nextOption match {
      case Some(parent: Call) =>
        val n = parent.name
        if (n == Operators.fieldAccess || n == Operators.indirectFieldAccess ||
            n == Operators.indexAccess || n == Operators.indirectIndexAccess) {
          // Walking up through struct/array accessors — only on LHS path
          Try(parent.argument(1)).toOption match {
            case Some(p1) if p1 == cur => walk(parent, sawAddressOf, depth - 1)
            case _ => false
          }
        } else if (n == Operators.addressOf) {
          walk(parent, sawAddressOf = true, depth - 1)
        } else if (n == Operators.cast) {
          walk(parent, sawAddressOf, depth - 1)
        } else if (sawAddressOf) {
          // We are inside a function call argument list — parent is a non-operator Call
          !n.startsWith("<operator>")
        } else {
          false
        }
      case _ => false
    }
  }
  walk(node, sawAddressOf = false, 8)
}

/**
 * Returns the canonical form for an expression *if* it normalizes to a known
 * canonical name (passed in). Used by pseudoRmwMatch to compare LHS vs RHS
 * references to the same shared variable.
 */
def canonicalOf(expr: Expression, globals: Set[String]): Option[String] = expr match {
  case id: Identifier if globals.contains(id.name) => Some(id.name)
  case c: Call if c.name == Operators.fieldAccess ||
                  c.name == Operators.indirectFieldAccess ||
                  c.name == Operators.indexAccess ||
                  c.name == Operators.indirectIndexAccess =>
    canonicalize(c, globals).map(_.canonicalName)
  case _ => None
}

/**
 * Detects "pseudo-RMW" pattern: a simple assignment `x = f(x, ...)` where the
 * LHS and the RHS both reference the same canonical variable. Examples:
 *   T[52] = T[52] + 1
 *   x     = x | mask
 *   s.fld = some_fn(s.fld)
 * In these cases the AST is a plain `<operator>.assignment` (not assignmentPlus),
 * but semantically it is an atomic-violation-relevant RMW: program first READs
 * the canonical variable on the RHS then WRITEs it on the LHS.
 *
 * Returns the canonical name iff the immediate-enclosing assignment is a
 * pseudo-RMW on this node (whether it's the LHS or somewhere in the RHS).
 */
def pseudoRmwCanonical(node: Expression, globals: Set[String]): Option[String] = {
  // Walk up through accessor wrappers to find the enclosing top-level expression
  def reachToplevel(cur: StoredNode, depth: Int): Option[StoredNode] = {
    if (depth <= 0) return None
    cur._astIn.nextOption match {
      case Some(parent: Call) =>
        val n = parent.name
        if (n == Operators.fieldAccess || n == Operators.indirectFieldAccess ||
            n == Operators.indexAccess || n == Operators.indirectIndexAccess ||
            n == Operators.indirection || n == Operators.cast) {
          reachToplevel(parent, depth - 1)
        } else {
          Some(parent)
        }
      case _ => None
    }
  }
  reachToplevel(node, 8).flatMap {
    case assign: Call if assign.name == Operators.assignment =>
      val lhs = Try(assign.argument(1)).toOption
      val rhs = Try(assign.argument(2)).toOption
      val lhsCanon = lhs.collect { case e: Expression => e }.flatMap(canonicalOf(_, globals))
      // RHS may be a deep tree; check if it contains any reference to lhsCanon
      lhsCanon.flatMap { canon =>
        rhs.collect { case e: Expression => e }.flatMap { rhsExpr =>
          val rhsRefs = rhsExpr.ast.collect {
            case id: Identifier if id.name == canon => canon
            case c: Call if (c.name == Operators.fieldAccess ||
                             c.name == Operators.indirectFieldAccess ||
                             c.name == Operators.indexAccess ||
                             c.name == Operators.indirectIndexAccess) &&
                            canonicalize(c, globals).map(_.canonicalName).contains(canon) =>
              canon
          }.toList
          if (rhsRefs.nonEmpty) Some(canon) else None
        }
      }
    case _ => None
  }
}

/**
 * Determines whether this node, in the context of an enclosing pseudo-RMW
 * assignment, is the LHS (WRITE side) or appears inside the RHS subtree
 * (READ side). Used to assign the right access type when expanding pseudo-RMW
 * into two access events.
 */
def isLhsOfEnclosingAssignment(node: Expression): Boolean = {
  def walk(cur: StoredNode, depth: Int): Boolean = {
    if (depth <= 0) return false
    cur._astIn.nextOption match {
      case Some(parent: Call) =>
        val n = parent.name
        if (n == Operators.assignment) {
          Try(parent.argument(1)).toOption.contains(cur)
        } else if (n == Operators.fieldAccess || n == Operators.indirectFieldAccess ||
                   n == Operators.indexAccess || n == Operators.indirectIndexAccess ||
                   n == Operators.indirection || n == Operators.cast) {
          // Must be on LHS path of accessor — walk up
          Try(parent.argument(1)).toOption match {
            case Some(p1) if p1 == cur => walk(parent, depth - 1)
            case _ => false
          }
        } else {
          false
        }
      case _ => false
    }
  }
  walk(node, 8)
}

/**
 * Returns true when this AST node (Identifier or accessor Call) is the LHS of
 * an RMW operation like `++`, `--`, `+=`, `|=`, etc. Such an access semantically
 * counts as TWO accesses to the same variable: a READ followed by a WRITE on the
 * same source location. intAtom (paper §3.1) treats RMW as a single atomic
 * "unit of work"; for our pattern matching this means a single `x++` can act as
 * both local1=READ and local2=WRITE when paired with a remote write to x.
 *
 * Looks for the immediate-enclosing operator on the LHS arg path.
 */
def rmwOpEnclosing(node: Expression): Option[String] = {
  // Walk through accessor wrappers (a.b, a->b, a[i], *a, (T)a) to find the
  // first non-accessor parent.
  def reachToplevelLhs(cur: StoredNode, depth: Int): Option[StoredNode] = {
    if (depth <= 0) return None
    cur._astIn.nextOption match {
      case Some(parent: Call) =>
        val n = parent.name
        if (n == Operators.fieldAccess || n == Operators.indirectFieldAccess ||
            n == Operators.indexAccess || n == Operators.indirectIndexAccess ||
            n == Operators.indirection || n == Operators.cast) {
          // accessor — must be on LHS path
          Try(parent.argument(1)).toOption.flatMap { lhs =>
            if (lhs == cur) reachToplevelLhs(parent, depth - 1) else None
          }
        } else {
          Some(parent)
        }
      case _ => None
    }
  }
  reachToplevelLhs(node, 6).flatMap {
    case call: Call if RMW_OPS.contains(call.name) =>
      // Must be on LHS (argument 1) — not a use on the RHS of an unrelated RMW.
      Try(call.argument(1)).toOption.flatMap { lhs =>
        // The LHS chain may have been wrapped — check if the original node is
        // on the LHS subtree. Simple sufficient condition: lhs == node directly,
        // or lhs's AST subtree contains node.
        if (lhs == node) Some(call.name)
        else if (lhs.ast.toList.contains(node)) Some(call.name)
        else None
      }
    case _ => None
  }
}

def mkLoc(n: AstNode): SourceLoc =
  SourceLoc(safeFile(n), safeLine(n), safeCol(n), enclosingFunc(n), codeOf(n))

def mkAccess(expr: Expression, alias: AliasNorm, entryFunc: String): VarAccess = {
  VarAccess(
    variableName = alias.originalExpression,
    accessType   = determineAccessType(expr),
    location     = mkLoc(expr),
    entryFunction = entryFunc,
    expression   = codeOf(expr),
    role         = "UNKNOWN",
  )
}

// ──────────────────────────────────────────────────────────────────────────────
// Stage 1 — 5 subroutines
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 1. Discover shared variables — globals + statics accessed by ≥2 entry-reachable
 *    function sets. An entry is either a task entry or an ISR entry.
 *
 *    Returns a map from canonical name → AliasNorm representative.
 */
// Top-level call graph + reachability helpers (used by multiple stages)
lazy val callGraphCache: Map[String, Set[String]] =
  cpg.method
    .filter(isUserMethod)
    .map(m => (m.name, m.call.filter(!_.isInline).callee.filter(isUserMethod).name.toSet))
    .l.toMap

// ──────────────────────────────────────────────────────────────────────────────
// Stage 2 — Protection primitive identification
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Platform-aware list of interrupt enable/disable primitives, expressed as
 * (predicate, effect) where effect ∈ {"DISABLE", "ENABLE"}.
 *
 * 8051 (Keil C51) uses the SFR assignment `EA = 0` / `EA = 1`.
 * ARM Cortex-M uses calls `__disable_irq()` / `__enable_irq()`.
 * SPARC LEON3 / RTEMS uses `sparc_disable_interrupt()`/`sparc_enable_interrupt()`,
 *   `rtems_interrupt_disable()`/`rtems_interrupt_enable()`.
 * FreeRTOS uses `taskENTER_CRITICAL()`/`taskEXIT_CRITICAL()` or
 *   `portENTER_CRITICAL()`/`portEXIT_CRITICAL()`.
 *
 * Recognized as: any Call node whose name matches; OR any assignment whose
 * LHS is `EA` (8051 idiom) and RHS literal value is 0/1.
 */
val DISABLE_CALL_NAMES: Set[String] = Set(
  "__disable_irq", "__disable_interrupt",
  "sparc_disable_interrupt", "rtems_interrupt_disable",
  "taskENTER_CRITICAL", "portENTER_CRITICAL",
  "OS_ENTER_CRITICAL",
)
val ENABLE_CALL_NAMES: Set[String] = Set(
  "__enable_irq", "__enable_interrupt",
  "sparc_enable_interrupt", "rtems_interrupt_enable",
  "taskEXIT_CRITICAL", "portEXIT_CRITICAL",
  "OS_EXIT_CRITICAL",
)

/** Detects `EA = 0` (DISABLE) or `EA = 1` (ENABLE) — 8051 SFR style. Returns
 *  Some("DISABLE"|"ENABLE") when matched. */
def detect8051EA(call: Call): Option[String] = {
  if (call.name != Operators.assignment) return None
  Try {
    val lhs = call.argument(1)
    val rhs = call.argument(2)
    lhs match {
      case id: Identifier if id.name == "EA" =>
        rhs match {
          case lit: Literal =>
            val v = lit.code.trim
            if (v == "0" || v == "0u" || v == "0U") Some("DISABLE")
            else if (v == "1" || v == "1u" || v == "1U") Some("ENABLE")
            else None
          case _ => None
        }
      case _ => None
    }
  }.toOption.flatten
}

/** A protection region (start_line, end_line) inside a single function:
 *  any access whose line is in [start, end] (inclusive) is treated as
 *  guarded by a critical section. */
case class ProtectionRegion(startLine: Int, endLine: Int, source: String)

/**
 * Discover protection regions inside a function by pairing disable→enable
 * events in source-order. Nested protection is handled with a depth counter:
 * the outermost disable→enable forms one region.
 */
def discoverProtectionRegions(fn: String): List[ProtectionRegion] = {
  val regions = mutable.ListBuffer[ProtectionRegion]()
  val method = cpg.method.nameExact(fn).headOption.getOrElse(return regions.toList)

  // Collect all events: (line, type, source) where type ∈ {DISABLE, ENABLE}
  case class Evt(line: Int, kind: String, src: String)
  val events = mutable.ListBuffer[Evt]()

  method.ast.foreach { node =>
    node match {
      case c: Call =>
        val ln = c.lineNumber.map(_.intValue()).getOrElse(-1)
        if (ln > 0) {
          if (DISABLE_CALL_NAMES.contains(c.name)) {
            events += Evt(ln, "DISABLE", c.name)
          } else if (ENABLE_CALL_NAMES.contains(c.name)) {
            events += Evt(ln, "ENABLE", c.name)
          } else {
            // 8051 EA assignment
            detect8051EA(c) match {
              case Some("DISABLE") => events += Evt(ln, "DISABLE", "EA=0")
              case Some("ENABLE")  => events += Evt(ln, "ENABLE", "EA=1")
              case _ => ()
            }
          }
        }
      case _ => ()
    }
  }

  // Pair events in source order using a depth counter
  val sorted = events.toList.sortBy(e => (e.line, if (e.kind == "DISABLE") 0 else 1))
  var depth = 0
  var openLine = -1
  var openSrc = ""
  for (e <- sorted) {
    if (e.kind == "DISABLE") {
      if (depth == 0) { openLine = e.line; openSrc = e.src }
      depth += 1
    } else { // ENABLE
      depth -= 1
      if (depth <= 0 && openLine > 0) {
        regions += ProtectionRegion(openLine, e.line, openSrc)
        openLine = -1
        depth = 0
      }
    }
  }
  regions.toList
}

/** Returns true iff line `n` is inside any of the regions. */
def isLineInRegions(n: Int, regions: List[ProtectionRegion]): Boolean =
  regions.exists(r => n >= r.startLine && n <= r.endLine)

// ──────────────────────────────────────────────────────────────────────────────
// Stage 3 (minimal) — init-phase exclusion + path-mutex detection
// ──────────────────────────────────────────────────────────────────────────────

/** Init-phase info: a set of fully-init-phase functions (all their accesses
 *  are pre-enable) and the main's first-enable line (used for line-level
 *  filtering of main's own accesses). */
case class InitPhaseInfo(funcs: Set[String], mainEnableLine: Int)

/** Detect functions called BEFORE the first interrupt-enable call in main().
 *  These functions execute when interrupts are disabled, so ISRs cannot
 *  preempt their accesses. Per intAtom §4.3b.
 *  Note: `main` itself is NOT included — main contains both init-phase code
 *  (before enable) and runtime loop. Line-level filtering handles this. */
def discoverInitPhaseInfo(): InitPhaseInfo = {
  val mainOpt = cpg.method.nameExact("main").headOption
  if (mainOpt.isEmpty) return InitPhaseInfo(Set.empty, -1)
  val main = mainOpt.get

  // Find first interrupt-enable line in main
  val enableEvents = main.ast.isCall.toList.flatMap { c =>
    val ln = c.lineNumber.map(_.intValue()).getOrElse(-1)
    if (ln <= 0) None
    else if (ENABLE_CALL_NAMES.contains(c.name)) Some((ln, c.name))
    else detect8051EA(c) match {
      case Some("ENABLE") => Some((ln, "EA=1"))
      case _ => None
    }
  }.sortBy(_._1)
  if (enableEvents.isEmpty) return InitPhaseInfo(Set.empty, -1)
  val enableLine = enableEvents.head._1

  // All functions called from main before enableLine, recursively.
  // Do NOT include `main` itself.
  val initFuncs = mutable.Set[String]()
  val q = mutable.Queue[String]()
  main.call.filter(c => c.lineNumber.exists(_.intValue() < enableLine))
        .callee.filter(isUserMethod).name.foreach { fn =>
    if (fn != "main" && !initFuncs.contains(fn)) {
      initFuncs += fn
      q.enqueue(fn)
    }
  }
  while (q.nonEmpty && initFuncs.size < 200) {
    val f = q.dequeue()
    callGraphCache.getOrElse(f, Set.empty).foreach { c =>
      if (c != "main" && !initFuncs.contains(c)) {
        initFuncs += c
        q.enqueue(c)
      }
    }
  }
  InitPhaseInfo(initFuncs.toSet, enableLine)
}

// Compatibility shim — old name still callable
def discoverInitPhaseFunctions(): Set[String] = discoverInitPhaseInfo().funcs

/** Collect enclosing if/while/switch conditions on the AST path from the
 *  method root to a target line. Returns a list of (condition_expr, branch)
 *  where branch ∈ {"true", "false"}. */
def collectEnclosingConditions(fn: String, line: Int): List[(String, String)] = {
  val method = cpg.method.nameExact(fn).headOption.getOrElse(return List.empty)
  // Find an AST node at or near the given line
  val targets = method.ast.filter(n =>
    n.lineNumber.exists(_.intValue() == line)
  ).l
  if (targets.isEmpty) return List.empty
  val target = targets.head

  // Walk up the AST collecting branch conditions
  val conds = mutable.ListBuffer[(String, String)]()
  def walk(cur: AstNode, depth: Int): Unit = {
    if (depth <= 0) return
    cur._astIn.nextOption match {
      case Some(parent: ControlStructure) =>
        val ctrlType = Try(parent.controlStructureType).getOrElse("")
        if (ctrlType == "IF" || ctrlType == "WHILE" || ctrlType == "DO" ||
            ctrlType == "FOR" || ctrlType == "SWITCH") {
          val condOpt = parent.condition.headOption.map(_.code)
          condOpt.foreach { c =>
            // Determine branch: is the target in the "then" or "else"?
            // Simplification: if the target's line is after the condition line
            // and before/at the parent's end, classify as "true" branch.
            // (Full branch-id determination requires CFG analysis.)
            conds += ((c, "true"))
          }
        }
        walk(parent, depth - 1)
      case Some(parent: AstNode) =>
        walk(parent, depth - 1)
      case _ => ()
    }
  }
  walk(target, 12)
  conds.reverse.toList
}

/** Compare two condition lists; return true if the two condition sets are
 *  contradictory (path-mutex). Simple syntactic check: same operand variable
 *  compared to two literally different equality values. */
def isPathMutex(condsL1: List[(String, String)], condsL2: List[(String, String)]): Boolean = {
  // For each condition in L1 of form `var == X`, check whether L2 has
  // `var == Y` with Y != X (literal-comparison mutex).
  val eqPattern = """\s*(\w+(?:\s*[.\->]\s*\w+)*)\s*==\s*(\w+|\d+|0x[0-9a-fA-F]+|TRUE|FALSE|true|false)\s*""".r
  def parseEq(s: String): Option[(String, String)] = s match {
    case eqPattern(v, lit) => Some((v.trim.replaceAll("\\s+", ""), lit.trim))
    case _ => None
  }
  val l1Eqs = condsL1.flatMap { case (c, _) => parseEq(c) }
  val l2Eqs = condsL2.flatMap { case (c, _) => parseEq(c) }
  l1Eqs.exists { case (v1, lit1) =>
    l2Eqs.exists { case (v2, lit2) =>
      v1 == v2 && lit1 != lit2
    }
  }
}

def reachableFuncs(entry: String, maxFuncs: Int = 1000): Set[String] = {
  val visited = mutable.Set[String](entry)
  val q = mutable.Queue[String](entry)
  while (q.nonEmpty && visited.size < maxFuncs) {
    val cur = q.dequeue()
    callGraphCache.getOrElse(cur, Set.empty).foreach { c =>
      if (!visited.contains(c) && visited.size < maxFuncs) {
        visited += c
        q.enqueue(c)
      }
    }
  }
  visited.toSet
}

def discoverSharedVariables(p: SvaParams): Map[String, AliasNorm] = {
  val globalsRoots = allGlobalVars()
  println(s"[singlevar-stage1] Global var roots: ${globalsRoots.size}")

  val entries: List[String] = p.taskEntries ++ p.isrEntries

  // For each entry, collect the set of (canonicalName, AliasNorm) accessed
  // anywhere in its reachable function set.
  val entryToAccesses: Map[String, Map[String, AliasNorm]] = entries.map { entry =>
    val funs = reachableFuncs(entry)
    val accs = mutable.Map[String, AliasNorm]()
    funs.foreach { fn =>
      cpg.method(fn).ast.foreach { node =>
        node match {
          case id: Identifier if globalsRoots.contains(id.name) && !isBaseOfMemberAccess(id) =>
            canonicalize(id, globalsRoots).foreach(a => accs.getOrElseUpdate(a.canonicalName, a))
          case call: Call if call.name == Operators.fieldAccess ||
                             call.name == Operators.indirectFieldAccess ||
                             call.name == Operators.indexAccess ||
                             call.name == Operators.indirectIndexAccess =>
            canonicalize(call, globalsRoots).foreach(a => accs.getOrElseUpdate(a.canonicalName, a))
          case _ => ()
        }
      }
    }
    (entry, accs.toMap)
  }.toMap

  // Shared = accessed by ≥2 entries
  val countMap = mutable.Map[String, Int]()
  val repMap   = mutable.Map[String, AliasNorm]()
  entryToAccesses.values.foreach { m =>
    m.foreach { case (canon, alias) =>
      countMap.update(canon, countMap.getOrElse(canon, 0) + 1)
      repMap.getOrElseUpdate(canon, alias)
    }
  }
  val shared = countMap.filter { case (_, c) => c >= 2 }.keySet
  shared.iterator.map(c => c -> repMap(c)).toMap
}

/**
 * 2. Build alias normalization map — already partly done in discoverSharedVariables.
 *    This function is kept as a separate stage to capture MMIO patterns from #define
 *    macros (Phase 3+) and to provide a single point of override for project-specific
 *    rules.
 */
def buildAliasNormalization(sharedVars: Map[String, AliasNorm], p: SvaParams): Map[String, AliasNorm] = {
  // Phase 1: pass-through. Phase 3 will inject MMIO normalization here.
  sharedVars
}

/**
 * 3. Find consecutive local access pairs within each entry function.
 *
 *    Phase 1 limits to SAME-FUNCTION pairs. A "consecutive pair" (e1, e2) means:
 *      - e1 and e2 access the same canonical variable
 *      - no other access to the same canonical variable appears on any CFG
 *        path between them (within the function)
 *
 *    Implementation: collect all accesses in source order within the function,
 *    then for each pair of adjacent same-canonical accesses, check that no
 *    other access to the same canonical sits between them.
 *
 *    Note: source-order proxy is a reasonable approximation for "no intervening
 *    access on any path" when the function is structured (no goto, no complex
 *    fall-through). For correctness in general CFGs, a proper CFG analysis
 *    would be needed; Phase 1 accepts this approximation given that
 *    benchmark cases are well-structured.
 */
def findConsecutivePairs(
  sharedVars: Map[String, AliasNorm],
  aliasMap: Map[String, AliasNorm],
  p: SvaParams,
): List[Pair] = {
  val pairs = mutable.ListBuffer[Pair]()
  var counter = 0

  // Phase 1: local pairs ONLY come from low-priority contexts (tasks).
  // ISR↔ISR interleaving requires interrupt_priorities and is deferred to Phase 3.
  // Each task entry is treated as a single function for now (cross-function
  // relaxation per skill §5 also deferred to Phase 3).
  for (entry <- p.taskEntries) {
    val funcsToScan = List(entry)

    funcsToScan.foreach { fn =>
      if (cpg.method.nameExact(fn).headOption.isEmpty) {
        println(s"[singlevar-stage1]   ! task entry not found in CPG: $fn (skipped)")
      }
      // Collect all accesses (Identifier or struct/array/* call) referencing a shared var.
      // Each AST node may yield 1 or 2 access entries: a single READ/WRITE for plain
      // accesses, OR (READ then WRITE) for RMW operations like `x++`, `x |= mask`,
      // OR a single READ or single WRITE for pseudo-RMW (`x = f(x)`).
      // Pseudo-RMW handling: LHS gets WRITE with synthesized col=+1000 (so it
      // appears AFTER the RHS occurrence even though source col is earlier).
      val globals = allGlobalVars()
      val rawAccesses: List[(AstNode, AliasNorm, String, Int)] = cpg.method(fn).ast.toList.flatMap { node =>
        node match {
          case id: Identifier if !isBaseOfMemberAccess(id) =>
            sharedVars.values
              .find(a => a.rule == "EXACT" && a.canonicalName == id.name)
              .toList.flatMap { a =>
                val baseCol = safeCol(id)
                rmwOpEnclosing(id) match {
                  case Some(_) =>
                    List(
                      (id.asInstanceOf[AstNode], a, "READ", baseCol),
                      (id.asInstanceOf[AstNode], a, "WRITE", baseCol + 1),
                    )
                  case None =>
                    pseudoRmwCanonical(id, globals) match {
                      case Some(canon) if canon == a.canonicalName =>
                        if (isLhsOfEnclosingAssignment(id)) {
                          List((id.asInstanceOf[AstNode], a, "WRITE", baseCol + 1000))
                        } else {
                          List((id.asInstanceOf[AstNode], a, "READ", baseCol))
                        }
                      case _ =>
                        if (isAddressOfPassedToCall(id)) {
                          // &x passed to a function — conservatively (R, W) RMW
                          List(
                            (id.asInstanceOf[AstNode], a, "READ", baseCol),
                            (id.asInstanceOf[AstNode], a, "WRITE", baseCol + 1),
                          )
                        } else {
                          List((id.asInstanceOf[AstNode], a, determineAccessType(id), baseCol))
                        }
                    }
                }
              }
          case call: Call if call.name == Operators.fieldAccess ||
                             call.name == Operators.indirectFieldAccess ||
                             call.name == Operators.indexAccess ||
                             call.name == Operators.indirectIndexAccess =>
            canonicalize(call, globals).toList.flatMap { a =>
              if (sharedVars.contains(a.canonicalName)) {
                val baseCol = safeCol(call)
                rmwOpEnclosing(call) match {
                  case Some(_) =>
                    List(
                      (call.asInstanceOf[AstNode], a, "READ", baseCol),
                      (call.asInstanceOf[AstNode], a, "WRITE", baseCol + 1),
                    )
                  case None =>
                    pseudoRmwCanonical(call, globals) match {
                      case Some(canon) if canon == a.canonicalName =>
                        if (isLhsOfEnclosingAssignment(call)) {
                          List((call.asInstanceOf[AstNode], a, "WRITE", baseCol + 1000))
                        } else {
                          List((call.asInstanceOf[AstNode], a, "READ", baseCol))
                        }
                      case _ =>
                        if (isAddressOfPassedToCall(call)) {
                          List(
                            (call.asInstanceOf[AstNode], a, "READ", baseCol),
                            (call.asInstanceOf[AstNode], a, "WRITE", baseCol + 1),
                          )
                        } else {
                          List((call.asInstanceOf[AstNode], a, determineAccessType(call), baseCol))
                        }
                    }
                }
              } else List.empty
            }
          case _ => List.empty
        }
      }

      // Group by canonical and dedupe by (line, col, code, accessType).
      val byCanonical: Map[String, List[(AstNode, AliasNorm, String, Int)]] =
        rawAccesses.groupBy { case (_, a, _, _) => a.canonicalName }

      byCanonical.foreach { case (canon, accs) =>
        // Sort by source (line, synthesized column) then dedupe
        val sorted = accs.distinctBy(t => (safeLine(t._1), t._4, codeOf(t._1), t._3))
                         .sortBy(t => (safeLine(t._1), t._4))

        // Pair-formation rules per access-pattern semantics:
        //   (R, R), (R, W), (W, R) main pairs: strict-consecutive (no intervening access)
        //   (W, W) main pair:                  may skip intervening READS (the WRW and
        //                                       WWW patterns concern two writes; reads
        //                                       between them don't invalidate the pair).
        //
        // Therefore we produce two kinds of pairs:
        //   1. Strict consecutive (i, i+1) — for all (l1, l2) types
        //   2. Skip-read W→W (the next W after a W, regardless of intervening R's)

        // (1) Strict consecutive pairs
        for (i <- 0 until (sorted.length - 1)) {
          val (n1, a1, t1, _) = sorted(i)
          val (n2, _,  t2, _) = sorted(i + 1)
          counter += 1
          val id = s"pair_${entry}_${canon.replaceAll("[^A-Za-z0-9_]", "_")}_${counter}"
          val l1Access = mkAccess(n1.asInstanceOf[Expression], a1, entry).copy(accessType = t1)
          val l2Access = mkAccess(n2.asInstanceOf[Expression], a1, entry).copy(accessType = t2)
          pairs += Pair(
            id            = id,
            variableName  = a1.originalExpression,
            canonicalVar  = canon,
            local1        = l1Access,
            local2        = l2Access,
            sameFunction  = true,
            crossFunction = None,
          )
        }

        // (2) (W, W) skip-read pairs: for each W, find the next W skipping
        //     any intervening READs. Only emit when there is at least one R
        //     in between (otherwise it's already covered by (1)).
        val writeIndices = sorted.zipWithIndex.collect { case ((_, _, "WRITE", _), idx) => idx }
        for (k <- 0 until writeIndices.length - 1) {
          val i = writeIndices(k)
          val j = writeIndices(k + 1)
          if (j > i + 1) {
            // There's at least one non-W access between; verify it's a READ
            // (skipping over a W would mean the W-W pair is no longer adjacent
            // in any meaningful sense — we don't form such pairs).
            val between = (i + 1 until j).map(sorted(_))
            if (between.forall(_._3 == "READ")) {
              val (n1, a1, _, _) = sorted(i)
              val (n2, _, _, _)  = sorted(j)
              counter += 1
              val id = s"pair_${entry}_${canon.replaceAll("[^A-Za-z0-9_]", "_")}_ww_${counter}"
              val l1Access = mkAccess(n1.asInstanceOf[Expression], a1, entry).copy(accessType = "WRITE")
              val l2Access = mkAccess(n2.asInstanceOf[Expression], a1, entry).copy(accessType = "WRITE")
              pairs += Pair(
                id            = id,
                variableName  = a1.originalExpression,
                canonicalVar  = canon,
                local1        = l1Access,
                local2        = l2Access,
                sameFunction  = true,
                crossFunction = None,
              )
            }
          }
        }
      }
    }
  }

  pairs.toList
}

/**
 * 4. Enumerate ISR remote accesses to shared variables.
 */
def enumerateRemoteAccesses(
  sharedVars: Map[String, AliasNorm],
  aliasMap: Map[String, AliasNorm],
  p: SvaParams,
): List[Remote] = {
  val remotes = mutable.ListBuffer[Remote]()

  val globals = allGlobalVars()
  p.isrEntries.foreach { isr =>
    val prio = p.interruptPriorities.getOrElse(isr, 0)
    // ISR context extends to all functions reachable from the ISR entry.
    // Accesses in callees are part of the interrupt context.
    val isrReachable = reachableFuncs(isr)

    isrReachable.foreach { fn =>
      cpg.method.nameExact(fn).ast.foreach { node =>
        node match {
          case id: Identifier if !isBaseOfMemberAccess(id) =>
            sharedVars.values
              .find(a => a.rule == "EXACT" && a.canonicalName == id.name)
              .foreach { a =>
                remotes += Remote(isr, prio, mkAccess(id, a, isr), a.canonicalName)
              }
          case call: Call if call.name == Operators.fieldAccess ||
                             call.name == Operators.indirectFieldAccess ||
                             call.name == Operators.indexAccess ||
                             call.name == Operators.indirectIndexAccess =>
            canonicalize(call, globals).foreach { a =>
              if (sharedVars.contains(a.canonicalName)) {
                remotes += Remote(isr, prio, mkAccess(call, a, isr), a.canonicalName)
              }
            }
          case _ => ()
        }
      }
    }
  }

  // Deduplicate by (isr, canonical, line, column)
  remotes.toList.distinctBy(r => (r.isrName, r.canonicalVar,
                                   r.access.location.line, r.access.location.column))
}

/**
 * 5. Match patterns: for each pair × each compatible remote, classify into
 *    {RWR, RWW, WRW, WWR, WWW} based on local1.access_type, remote.access_type,
 *    local2.access_type.
 *
 *    Scoring per SKILL §3:
 *      AQ: RWR=0.50, RWW=0.55, WRW=0.45, WWR=0.45, WWW=0.40
 *      OE: volatile_marked +0.10, multi_isr +0.08, no_protection +0.15, rmw_op +0.08
 *           (Phase 1 implements volatile_marked and rmw_op; multi_isr and
 *            no_protection come in Phase 3)
 *      Cross-function multiplier: 1.0 for same-function
 */
def matchPatterns(
  pairs: List[Pair],
  remotes: List[Remote],
  aliasMap: Map[String, AliasNorm],
  p: SvaParams,
): List[Candidate] = {
  val candidates = mutable.ListBuffer[Candidate]()
  var counter = 0

  // Group remotes by canonical variable for O(N) join
  val remotesByCanonical: Map[String, List[Remote]] = remotes.groupBy(_.canonicalVar)

  // Multi-ISR detection: which canonical vars are touched by >1 ISR
  val multiIsrVars: Set[String] = remotes.groupBy(_.canonicalVar)
    .filter { case (_, rs) => rs.map(_.isrName).distinct.size >= 2 }
    .keySet

  // Stage 2 — discover protection regions per task function. We protect by
  // function, not globally, because critical sections may differ across
  // functions (a task's disable doesn't shield another task's pair).
  val protectionByFunc: Map[String, List[ProtectionRegion]] =
    p.taskEntries.map(fn => (fn, discoverProtectionRegions(fn))).toMap

  // Stage 3 (minimal) — init-phase info
  val initInfo = discoverInitPhaseInfo()
  val initPhaseFuncs = initInfo.funcs
  println(s"[singlevar-stage1] Stage3: init-phase functions = ${initPhaseFuncs.size}" +
          (if (initInfo.mainEnableLine > 0) s", main_enable_line=${initInfo.mainEnableLine}" else ""))

  /** Check if an access is in the pre-enable init phase. Either:
   *    (a) its function is in initPhaseFuncs (entirely pre-enable), or
   *    (b) its function is main AND its line < mainEnableLine. */
  def isAccessInInitPhase(fn: String, line: Int): Boolean = {
    if (initPhaseFuncs.contains(fn)) return true
    if (fn == "main" && initInfo.mainEnableLine > 0 &&
        line > 0 && line < initInfo.mainEnableLine) return true
    false
  }

  // Pairs whose BOTH local1 and local2 are inside a single protection region
  // are FULLY-PROTECTED — drop them entirely.
  // Pairs where EITHER local1 or local2 (but not both) are in a protection
  // region are PARTIALLY-PROTECTED — keep but downscore (the ISR can still
  // preempt on the unprotected side).
  def pairProtectionStatus(pair: Pair): String = {
    if (!pair.sameFunction) return "NONE"
    if (pair.local1.entryFunction != pair.local2.entryFunction) return "NONE"
    val regions = protectionByFunc.getOrElse(pair.local1.entryFunction, List.empty)
    if (regions.isEmpty) return "NONE"
    val l1 = pair.local1.location.line
    val l2 = pair.local2.location.line
    val l1Covered = regions.exists(r => l1 >= r.startLine && l1 <= r.endLine)
    val l2Covered = regions.exists(r => l2 >= r.startLine && l2 <= r.endLine)
    val sameRegion = regions.exists(r =>
      l1 >= r.startLine && l1 <= r.endLine &&
      l2 >= r.startLine && l2 <= r.endLine
    )
    if (sameRegion) "FULL"
    else if (l1Covered || l2Covered) "PARTIAL"
    else "NONE"
  }
  val pairStatus: Map[String, String] = pairs.map(p => p.id -> pairProtectionStatus(p)).toMap
  val protectedPairIds: Set[String] = pairStatus.filter(_._2 == "FULL").keySet
  val partiallyProtected: Set[String] = pairStatus.filter(_._2 == "PARTIAL").keySet
  if (protectedPairIds.nonEmpty || partiallyProtected.nonEmpty) {
    println(s"[singlevar-stage1] Stage2: ${protectedPairIds.size} fully-protected (filtered), " +
            s"${partiallyProtected.size} partially-protected (downscored)")
  }

  // Stage 3 init-phase exclusion: drop pairs whose BOTH accesses are in
  // init-phase (either pure-init function OR main pre-enable). Line-level
  // for main; function-level for non-main.
  val initPhasePairIds: Set[String] = pairs.collect {
    case pair if isAccessInInitPhase(pair.local1.entryFunction, pair.local1.location.line) &&
                 isAccessInInitPhase(pair.local2.entryFunction, pair.local2.location.line) => pair.id
  }.toSet
  if (initPhasePairIds.nonEmpty) {
    println(s"[singlevar-stage1] Stage3: ${initPhasePairIds.size} pairs filtered as init-phase")
  }

  // Stage 3 path-mutex detection: drop pairs whose enclosing conditions
  // are syntactically contradictory (e.g., `if(x==0)` vs `if(x==1)`).
  val pathMutexPairIds: Set[String] = pairs.flatMap { pair =>
    if (pair.local1.entryFunction != pair.local2.entryFunction) None
    else {
      val condsL1 = collectEnclosingConditions(pair.local1.entryFunction, pair.local1.location.line)
      val condsL2 = collectEnclosingConditions(pair.local2.entryFunction, pair.local2.location.line)
      if (isPathMutex(condsL1, condsL2)) Some(pair.id) else None
    }
  }.toSet
  if (pathMutexPairIds.nonEmpty) {
    println(s"[singlevar-stage1] Stage3: ${pathMutexPairIds.size} pairs filtered as path-mutex")
  }

  val droppedPairIds: Set[String] = protectedPairIds ++ initPhasePairIds ++ pathMutexPairIds

  pairs.filterNot(p => droppedPairIds.contains(p.id)).foreach { pair =>
    val candidateRemotes = remotesByCanonical.getOrElse(pair.canonicalVar, List.empty)

    candidateRemotes.foreach { rem =>
      val l1Type = pair.local1.accessType
      val l2Type = pair.local2.accessType
      val rType  = rem.access.accessType

      val patternOpt: Option[String] = (l1Type, rType, l2Type) match {
        case ("READ",  "WRITE", "READ")  => Some("RWR")
        case ("READ",  "WRITE", "WRITE") => Some("RWW")
        case ("WRITE", "READ",  "WRITE") => Some("WRW")
        case ("WRITE", "WRITE", "READ")  => Some("WWR")
        case ("WRITE", "WRITE", "WRITE") => Some("WWW")
        case _ => None
      }

      patternOpt.foreach { pat =>
        // AQ
        val aq: Double = pat match {
          case "RWR" => 0.50
          case "RWW" => 0.55
          case "WRW" => 0.45
          case "WWR" => 0.45
          case "WWW" => 0.40
        }

        // OE
        var oe = 0.0
        val evidence = mutable.Map[String, Double]()
        evidence("aq") = aq

        // volatile_marked: check via type of canonical's root variable
        val isVolatile = pair.canonicalVar.split("""[\.\->\[]""").headOption.flatMap { root =>
          cpg.local.name(root).headOption.map(_.typeFullName)
        }.exists(_.toLowerCase.contains("volatile"))
        if (isVolatile) {
          oe += 0.10
          evidence("volatile_marked") = 0.10
        }

        // multi_isr
        if (multiIsrVars.contains(pair.canonicalVar)) {
          oe += 0.08
          evidence("multi_isr") = 0.08
        }

        // rmw_op: check whether local2 is an RMW
        val isRmw = pat match {
          case "RWW" =>
            // Look up the AST around local2's line; if its enclosing assignment is RMW
            // (Phase 1 simple heuristic — for L1 cases this suffices)
            val l2Line = pair.local2.location.line
            cpg.method(pair.local2.entryFunction).call
              .filter(c => c.lineNumber.contains(l2Line))
              .name.toList.exists(name => RMW_OPS.contains(name))
          case _ => false
        }
        if (isRmw) {
          oe += 0.08
          evidence("rmw_op") = 0.08
        }

        oe = math.min(oe, 0.30)

        // Partial-protection NOTE (no score change):
        //   When one side (but not both) of the pair is inside a critical
        //   section, this is actually a STRONG signal that the developer
        //   recognized the race but didn't fully implement the fix. Keep at
        //   full score and just record the evidence for the report.
        if (partiallyProtected.contains(pair.id)) {
          evidence("partial_protection") = 0.0
        }

        // ─────────────────────────────────────────────────────────────────
        // Heuristic intent signals (Stage 2 LLM-free pre-filter)
        // Penalties only — never positive — so they cannot drive a false
        // candidate ABOVE the threshold. Score decay let unlikely
        // candidates sink in the ranking; LLM (when available) confirms.
        // ─────────────────────────────────────────────────────────────────
        val canonLower = pair.canonicalVar.toLowerCase
        val rootName = pair.canonicalVar.split("""[\.\->\[]""").headOption.getOrElse("")
        val rootLower = rootName.toLowerCase

        var heuristicPenalty = 0.0

        // H1: Counter-like name + ISR is pure increment.
        //   tick++, count++, counter += 1 in ISR + main reads it elsewhere
        //   ≈ free-running counter, programmer rarely expects atomic snapshot.
        val nameSuggestsCounter =
          rootLower.contains("tick") || rootLower.contains("count") ||
          rootLower.endsWith("cnt") || rootLower.endsWith("_count") ||
          rootLower == "ticks" || rootLower == "ms" || rootLower == "ms_count"
        val isrIsIncrement =
          cpg.method.nameExact(rem.access.entryFunction).call
            .filter(c => c.lineNumber.contains(rem.access.location.line))
            .name.toList.exists(name =>
              name == "<operator>.postIncrement" ||
              name == "<operator>.preIncrement" ||
              name == "<operator>.assignmentPlus")
        if (nameSuggestsCounter && isrIsIncrement) {
          heuristicPenalty -= 0.15
          evidence("h_counter_pattern") = -0.15
        }

        // H2: MMIO register / hardware address — accessed via cast from
        //   integer literal (e.g., *(volatile uint32_t*)0x40000000).
        //   The canonical name typically contains the cast expression.
        val looksLikeMmio =
          pair.canonicalVar.contains("0x") ||
          pair.variableName.contains("0x") ||
          pair.variableName.contains("(volatile") ||
          rootLower.startsWith("xbyte") || rootLower == "xbyte"
        if (looksLikeMmio) {
          heuristicPenalty -= 0.20
          evidence("h_mmio_register") = -0.20
        }

        // H3: Status-flag pattern — variable name strongly suggests a
        //   one-shot boolean and the pattern is RWR, where the second read
        //   is in the same conditional block (already covered by RMW elsewhere).
        //   We DON'T penalize this — flags are often the most critical case.

        // H4: Init-only write — when main side l1=W in main() at very early
        //   line numbers AND l2 is far away (>500 lines), often the W is a
        //   one-shot init and not part of an atomic sequence.
        if (pair.local1.entryFunction == "main" &&
            pair.local1.location.line < 250 &&
            pair.local2.location.line - pair.local1.location.line > 500) {
          heuristicPenalty -= 0.15
          evidence("h_init_far_apart") = -0.15
        }

        // H5: Same-line RMW already gets the RMW-relaxation bonus from the
        //   matcher; no extra adjustment here.

        // H6: Array index symbolic + pattern WWW — bulk update of array,
        //   programmer rarely expects atomicity on individual elements.
        if (pat == "WWW" &&
            (pair.canonicalVar.endsWith("[*]") ||
             pair.variableName.endsWith("[*]"))) {
          heuristicPenalty -= 0.10
          evidence("h_array_bulk_write") = -0.10
        }

        // H7: ISR is itself ANOTHER counter-style increment (e.g., uptime
        //   tick in Timer ISR) AND main only reads it for display/comparison
        //   without storing back. Bonus rule: when pat == WWW and l1.line ==
        //   l2.line (same line accessed twice somehow via expansion), suppress
        //   if pair came from RMW expansion only (no real W-W in source).
        // (Skipped for now — needs cross-check with raw source.)

        // Cross-function multiplier (Phase 1: always 1.0 since same-function only)
        val cfMult = pair.crossFunction.map(_.confidenceMultiplier).getOrElse(1.0)

        val structuralScore = math.max(0.0, (aq + oe + heuristicPenalty) * cfMult)

        counter += 1
        val id = s"sva_${pat}_${pair.canonicalVar.replaceAll("[^A-Za-z0-9_]", "_")}_${counter}"

        candidates += Candidate(
          id              = id,
          pattern         = pat,
          variableName    = pair.variableName,
          canonicalVar    = pair.canonicalVar,
          aliasInfo       = aliasMap.get(pair.canonicalVar),
          consecutivePairId = pair.id,
          local1          = pair.local1,
          remote          = rem.access,
          local2          = pair.local2,
          remoteIsr       = rem,
          loopContexts    = List.empty, // Phase 1: not collected
          crossFunction   = pair.crossFunction,
          structuralScore = structuralScore,
          evidenceBreakdown = evidence.toMap,
        )
      }
    }
  }

  candidates.toList
}

// ──────────────────────────────────────────────────────────────────────────────
// JSON writers
// ──────────────────────────────────────────────────────────────────────────────

def locToJson(l: SourceLoc): ujson.Value = ujson.Obj(
  "file_path" -> l.filePath,
  "line"      -> l.line,
  "column"    -> l.column,
  "function"  -> l.function,
  "code"      -> l.code,
)

def accessToJson(a: VarAccess): ujson.Value = ujson.Obj(
  "variable_name"  -> a.variableName,
  "access_type"    -> a.accessType,
  "location"       -> locToJson(a.location),
  "entry_function" -> a.entryFunction,
  "expression"     -> a.expression,
  "role"           -> a.role,
)

def aliasToJson(a: AliasNorm): ujson.Value = ujson.Obj(
  "original_expression" -> a.originalExpression,
  "canonical_name"      -> a.canonicalName,
  "rule"                -> a.rule,
  "confidence"          -> a.confidence,
  "note"                -> a.note.fold(ujson.Null: ujson.Value)(ujson.Str(_)),
)

def cfToJson(c: CrossFn): ujson.Value = ujson.Obj(
  "call_chain"                  -> ujson.Arr.from(c.callChain),
  "depth"                       -> c.depth,
  "has_interrupt_state_change"  -> c.hasInterruptStateChange,
  "has_yield_call"              -> c.hasYieldCall,
  "has_spin_wait"               -> c.hasSpinWait,
  "confidence_multiplier"       -> c.confidenceMultiplier,
)

def pairToJson(p: Pair): ujson.Value = ujson.Obj(
  "id"             -> p.id,
  "variable_name"  -> p.variableName,
  "canonical_var"  -> p.canonicalVar,
  "local1"         -> accessToJson(p.local1),
  "local2"         -> accessToJson(p.local2),
  "same_function"  -> p.sameFunction,
  "cross_function" -> p.crossFunction.fold(ujson.Null: ujson.Value)(cfToJson),
  "pair_feasibility" -> "UNCHECKED",
)

def candToJson(c: Candidate): ujson.Value = ujson.Obj(
  "id"                  -> c.id,
  "pattern"             -> c.pattern,
  "variable_name"       -> c.variableName,
  "canonical_var"       -> c.canonicalVar,
  "alias_info"          -> c.aliasInfo.fold(ujson.Null: ujson.Value)(aliasToJson),
  "consecutive_pair_id" -> c.consecutivePairId,
  "accesses" -> ujson.Obj(
    "local1" -> accessToJson(c.local1),
    "remote" -> accessToJson(c.remote),
    "local2" -> accessToJson(c.local2),
  ),
  "remote_isr" -> ujson.Obj(
    "isr_name" -> c.remoteIsr.isrName,
    "priority" -> c.remoteIsr.priority,
    "access"   -> accessToJson(c.remoteIsr.access),
  ),
  "loop_contexts"     -> ujson.Arr.from(c.loopContexts),
  "cross_function"    -> c.crossFunction.fold(ujson.Null: ujson.Value)(cfToJson),
  "structural_score"  -> c.structuralScore,
  "evidence_breakdown" -> ujson.Obj.from(c.evidenceBreakdown.toSeq.map { case (k, v) =>
    (k, ujson.Num(v))
  }),
)

def writePairsJson(pairs: List[Pair], path: String, projectName: String): Unit = {
  val js = ujson.Obj(
    "project_name" -> projectName,
    "timestamp"    -> java.time.Instant.now().toString,
    "pairs"        -> ujson.Arr.from(pairs.map(pairToJson)),
    "summary" -> ujson.Obj(
      "total_pairs" -> pairs.size,
      "same_function_count" -> pairs.count(_.sameFunction),
      "cross_function_count" -> pairs.count(_.crossFunction.nonEmpty),
    ),
  )
  Files.write(Paths.get(path), ujson.write(js, indent = 2).getBytes(StandardCharsets.UTF_8))
}

def writeCandidatesJson(candidates: List[Candidate], path: String, projectName: String): Unit = {
  val byPattern: Map[String, Int] = candidates.groupBy(_.pattern).view.mapValues(_.size).toMap
  val js = ujson.Obj(
    "project_name" -> projectName,
    "timestamp"    -> java.time.Instant.now().toString,
    "candidates"   -> ujson.Arr.from(candidates.map(candToJson)),
    "summary" -> ujson.Obj(
      "total_candidates" -> candidates.size,
      "by_pattern" -> ujson.Obj.from(byPattern.toSeq.map { case (k, v) => (k, ujson.Num(v)) }),
    ),
  )
  Files.write(Paths.get(path), ujson.write(js, indent = 2).getBytes(StandardCharsets.UTF_8))
}

def writeMarkdownSummary(pairs: List[Pair], candidates: List[Candidate], path: String): Unit = {
  val sb = new StringBuilder()
  sb.append("# Single-Variable Atomicity — Stage 1 Candidates\n\n")
  sb.append(s"- Consecutive local pairs found: **${pairs.size}**\n")
  sb.append(s"- Pattern candidates: **${candidates.size}**\n\n")
  sb.append("## Pattern distribution\n\n")
  sb.append("| Pattern | Count |\n|---------|------:|\n")
  candidates.groupBy(_.pattern).toList.sortBy(_._1).foreach { case (pat, cs) =>
    sb.append(s"| $pat | ${cs.size} |\n")
  }
  sb.append("\n## Top candidates by structural score\n\n")
  sb.append("| ID | Pattern | Variable | Score | Local1 | Remote (ISR) | Local2 |\n")
  sb.append("|----|---------|----------|------:|--------|--------------|--------|\n")
  candidates.sortBy(-_.structuralScore).take(50).foreach { c =>
    sb.append(
      s"| ${c.id} | ${c.pattern} | ${c.canonicalVar} | ${"%.3f".format(c.structuralScore)} | " +
      s"${c.local1.entryFunction}:${c.local1.location.line} | " +
      s"${c.remoteIsr.isrName}:${c.remote.location.line} | " +
      s"${c.local2.entryFunction}:${c.local2.location.line} |\n"
    )
  }
  Files.write(Paths.get(path), sb.toString.getBytes(StandardCharsets.UTF_8))
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
//
// Invocation pattern: write a wrapper .sc that does
//   //> using file singlevarAtomicityIdentify.scala
//   importCpg("/path/to/cpg.bin")
//   applyDefaultOverlays(cpg)
//   runStage1("/path/to/singlevar-params.json")
// and call `joern --script wrapper.sc`. This matches the project's existing
// multivar-correlated-vars invocation convention (see multivar-correlated-vars.ts).
// ──────────────────────────────────────────────────────────────────────────────

def runStage1(paramsPath: String): Unit = {
  val p = SvaParamLoader.load(paramsPath)
  println(s"[singlevar-stage1] Project: ${p.projectName}")
  println(s"[singlevar-stage1] CPG:     ${p.cpgPath}")
  println(s"[singlevar-stage1] Tasks:   ${p.taskEntries.mkString(",")}")
  println(s"[singlevar-stage1] ISRs:    ${p.isrEntries.mkString(",")}")
  println(s"[singlevar-stage1] CPG method count=${cpg.method.size}")

  val sharedVars = discoverSharedVariables(p)
  println(s"[singlevar-stage1] Shared variables: ${sharedVars.size}")
  sharedVars.foreach { case (canon, alias) =>
    println(s"  - $canon (rule=${alias.rule})")
  }

  val aliasMap = buildAliasNormalization(sharedVars, p)

  val pairs = findConsecutivePairs(sharedVars, aliasMap, p)
  println(s"[singlevar-stage1] Consecutive pairs: ${pairs.size}")

  val remotes = enumerateRemoteAccesses(sharedVars, aliasMap, p)
  println(s"[singlevar-stage1] Remote accesses: ${remotes.size}")
  remotes.groupBy(_.canonicalVar).toList.sortBy(-_._2.size).foreach { case (cv, rs) =>
    println(s"  - $cv: ${rs.size} (${rs.map(r => s"${r.access.accessType}@${r.access.location.line}").mkString(",")})")
  }

  val candidates = matchPatterns(pairs, remotes, aliasMap, p)
  println(s"[singlevar-stage1] Candidates: ${candidates.size}")
  candidates.groupBy(_.pattern).foreach { case (pat, cs) =>
    println(s"  - $pat: ${cs.size}")
  }

  writePairsJson(pairs, p.pairsOutputPath, p.projectName)
  writeCandidatesJson(candidates, p.outputPath, p.projectName)
  writeMarkdownSummary(pairs, candidates, p.mdOutputPath)

  println(s"[singlevar-stage1] Done. Outputs:")
  println(s"  pairs: ${p.pairsOutputPath}")
  println(s"  candidates: ${p.outputPath}")
  println(s"  md: ${p.mdOutputPath}")
}

// ── Joern entry point (invoked via `joern --script <this> --param paramsPath=<json>`) ──
@main def run(): Unit = {
  val paramsPath: String = try {
    params.getOrElse("paramsPath", sys.error("Missing --param paramsPath=<path>"))
  } catch {
    case _: Throwable =>
      val fallback = ".matrix/data/singlevar-params.json"
      if (Files.exists(Paths.get(fallback))) fallback
      else sys.error("Cannot locate params file")
  }
  runStage1(paramsPath)
}
