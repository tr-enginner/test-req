// ════════════════════════════════════════════════════
// SECTION 1: IMPORTS
// ════════════════════════════════════════════════════
import _root_.io.shiftleft.codepropertygraph.generated.{help as _, *}
import _root_.io.shiftleft.semanticcpg.language.*
import _root_.io.shiftleft.semanticcpg.language.NoResolve
import io.joern.dataflowengineoss.passes.reachingdef.*
import io.joern.x2cpg.X2Cpg.applyDefaultOverlays
import _root_.io.shiftleft.codepropertygraph.generated.nodes.*
import io.shiftleft.semanticcpg.accesspath.*
import _root_.io.joern.joerncli.console.JoernConsole.*
import _root_.io.joern.joerncli.console.Joern.{cpg, *}
import io.joern.dataflowengineoss.DefaultSemantics
import io.joern.dataflowengineoss.dotgenerator.DdgGenerator
import io.joern.dataflowengineoss.semanticsloader.Semantics
import io.shiftleft.semanticcpg.dotgenerator.CfgGenerator
import ujson.{Arr, Obj, Value}
import io.joern.dataflowengineoss.queryengine.{Engine, EngineContext}
import io.joern.dataflowengineoss.slicing.{DataFlowConfig, DataFlowSlicing, SliceEdge, SliceNode}
import spray.json.*
import scala.collection.immutable.ListMap
import scala.collection.mutable
import scala.util.{Failure, Success, Try}
import java.util.concurrent.ConcurrentHashMap
import java.io.PrintWriter
import java.nio.file.Paths
import scala.io.Source
import scala.util.Using

implicit val resolver: ICallResolver = NoResolve

val filePath2Lines = ConcurrentHashMap[String, List[String]]()

val emptyDomain = Map[AccessPath, Set[StoredNode]]()
val emptyDataflowFact = Map[StoredNode, Map[AccessPath, Set[StoredNode]]]()

object APReachingDefProblem {
  def create(method: Method): DataFlowProblem[StoredNode, Map[AccessPath, Set[StoredNode]]] = {
    val flowGraph = new APReachingDefFlowGraph(method)
    val transferFunction = new APReachingDefTransferFunction()
    val inOutInit = new APReachingDefInOutInit()
    val meet = APReachingDefMeet
    new DataFlowProblem[StoredNode, Map[AccessPath, Set[StoredNode]]](
      flowGraph,
      transferFunction,
      meet,
      inOutInit,
      true,
      emptyDomain
    )
  }
}

class APReachingDefFlowGraph(method: Method) extends ReachingDefFlowGraph(method) {}

class APReachingDefInOutInit extends InOutInit[StoredNode, Map[AccessPath, Set[StoredNode]]] {
  override def initIn: Map[StoredNode, Map[AccessPath, Set[StoredNode]]] = {
    Map
      .empty[StoredNode, Map[AccessPath, Set[StoredNode]]]
      .withDefaultValue(Map.empty)
  }

  override def initOut: Map[StoredNode, Map[AccessPath, Set[StoredNode]]] = {
    Map
      .empty[StoredNode, Map[AccessPath, Set[StoredNode]]]
      .withDefaultValue(Map.empty)
  }
}

// merge two dataflow fact
def APReachingDefMeet(a: Map[AccessPath, Set[StoredNode]], b: Map[AccessPath, Set[StoredNode]]) = {
  val keySet = a.keySet ++ b.keySet
  keySet.map(ap => {
    val nodeSet1 = a.getOrElse(ap, Set[StoredNode]())
    val nodeSet2 = b.getOrElse(ap, Set[StoredNode]())
    (ap, nodeSet1++nodeSet2)
  }).toMap
}

def getAPElements(expr: Expression): Elements = {
  expr match {
    case id: Identifier => {
      Elements.normalized(ConstantAccess(id.name))
    }
    case literal: Literal => {
      Elements.normalized(ConstantAccess(literal.code))
    }
    case call: Call => {
      val callName = call.name
      callName match {
        case name if name == Operators.fieldAccess => {
          // a.f — direct field access
          val prefixExpr = call.argument(1)
          val suffix = call.argument(2).asInstanceOf[FieldIdentifier]
          val prefixAP = getAPElements(prefixExpr)
          val fieldName = suffix.code

          val finalApElements = Elements.normalized(prefixAP.elements :+ ConstantAccess(fieldName))
          finalApElements
        }
        case name if name == Operators.indirectFieldAccess => {
          // a->f  =>  a*.f — indirect field access (pointer dereference + field)
          val prefixExpr = call.argument(1)
          val suffix = call.argument(2).asInstanceOf[FieldIdentifier]
          val prefixAP = getAPElements(prefixExpr)
          val fieldName = suffix.code

          val finalApElements = Elements.normalized(prefixAP.elements :+ IndirectionAccess :+ ConstantAccess(fieldName))
          finalApElements
        }
        case name if name == Operators.indexAccess => {
          val prefixAP = getAPElements(call.argument(1))
          val finalAPElements = Elements.normalized(prefixAP.elements :+ VariablePointerShift)
          finalAPElements
        }
        case name if name == Operators.indirectIndexAccess => {
          // arr[i]  => prefix<?>
          val prefixAP = getAPElements(call.argument(1))
          val finalAPElements = Elements.normalized(prefixAP.elements :+ VariablePointerShift)
          finalAPElements
        }
        case name if name == Operators.indirection => {
          // *arr   =>  arr*
          val prefixAP = getAPElements(call.argument(1))
          val finalAPElements = Elements.normalized(prefixAP.elements :+ IndirectionAccess)
          finalAPElements
        }
        case name if name == Operators.cast => {
          // (int *) x
          val ap = getAPElements(call.argument(2))
          ap
        }
        case name if name == Operators.addition || name == Operators.minus => {
          // 0x100056 + si
          val ap = getAPElements(call.argument(1))
          val finalAPElements = Elements.normalized(ap.elements :+ VariablePointerShift)
          finalAPElements
        }
        case name if name == Operators.addressOf => {
          val ap = getAPElements(call.argument(1))
          val finalAPElements = Elements.normalized(ap.elements :+ AddressOf)
          finalAPElements
        }
        case name if call.isInline => {
          val finalElements = Elements.normalized(ConstantAccess(name))
          finalElements
        }
        case name => {
          val finalElements = Elements.normalized(ConstantAccess(call.name))
          finalElements
        }
      }
    }
    case _ => {
      Elements.empty
    }
  }
}

/**
 * Determine whether a node is accessed as READ or WRITE by inspecting
 * its AST parent chain. Handles direct assignment LHS, post-increment/
 * decrement, and pointer dereference (*ptr) on the LHS of assignment.
 */
def determineAccessType(node: StoredNode): String = {
  // Check if this node is on the LHS of an assignment by walking up the AST.
  // Handles complex LHS expressions like struct_array[idx].field = 5
  // where the identifier may be deeply nested (fieldAccess → indexAccess → assignment).
  val assignmentOps = Set(
    "<operator>.assignment", "<operators>.assignment",
    "<operator>.assignmentPlus", "<operator>.assignmentMinus",
    "<operator>.assignmentMultiplication", "<operator>.assignmentDivision",
    "<operator>.assignmentModulo",
    "<operator>.assignmentAnd", "<operator>.assignmentOr", "<operator>.assignmentXor",
    "<operator>.assignmentShiftLeft", "<operator>.assignmentArithmeticShiftRight",
    "<operator>.assignmentLogicalShiftRight",
    "<operator>.postDecrement", "<operator>.postIncrement",
    "<operator>.preDecrement", "<operator>.preIncrement"
  )
  // Walk up AST from node to find if it is on the LHS subtree of an assignment
  def isOnLhsOfAssignment(current: StoredNode, maxDepth: Int = 6): Boolean = {
    if (maxDepth <= 0) return false
    current._astIn.nextOption match {
      case Some(parentCall: Call) =>
        val name = parentCall.name
        if (assignmentOps.exists(op => name.startsWith(op) || name == op)) {
          // Check if 'current' is argument(1) (LHS) of this assignment
          Try(parentCall.argument(1)).toOption match {
            case Some(lhs) => lhs == current
            case None => false
          }
        } else if (name == Operators.fieldAccess || name == Operators.indirectFieldAccess ||
                   name == Operators.indexAccess || name == Operators.indirection ||
                   name == Operators.addressOf) {
          // Intermediate access operators (a.b, a->b, a[i], *a, &a) — walk up further
          isOnLhsOfAssignment(parentCall, maxDepth - 1)
        } else {
          false
        }
      case Some(parent: StoredNode) if !parent.isInstanceOf[Method] =>
        isOnLhsOfAssignment(parent, maxDepth - 1)
      case _ => false
    }
  }
  if (isOnLhsOfAssignment(node)) "WRITE" else "READ"
}

class APReachingDefTransferFunction extends TransferFunction[StoredNode, Map[AccessPath, Set[StoredNode]]] {

  override def apply(n: StoredNode, in: Map[AccessPath, Set[StoredNode]]): Map[AccessPath, Set[StoredNode]] = {
    var out = in
    n match {
      case m: Method => {
        out
      }
      case p: MethodParameterIn => {
        val apRoot = Elements.normalized(ConstantAccess(p.name))
        val ap = AccessPath(apRoot, Seq.empty)
        out = out + (ap -> p.toSet)
        out
      }
      case call: Call => {
        // a = b; a += b; a -= b;
        val callName = call.name
        callName match {
          case name if name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") || name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement") => {
            val left : Expression = call.argument(1)
            val apElements = getAPElements(left)
            if (!apElements.isEmpty) {
              val ap = AccessPath(apElements, Seq.empty)
              out = out + (ap -> call.toSet)
            }
          }
          case _ => {

          }
        }
        out
      }
      case _ => {
        out
      }
    }
  }
}

implicit val semantics: Semantics = DefaultSemantics()

case class VariableTrace(node: CfgNode, trace: List[CfgNode])


// ════════════════════════════════════════════════════
// SECTION 1: REACHING DEF & CORRELATED VARIABLE ANALYSIS
// ════════════════════════════════════════════════════
def useDefChainAnalysis(projectName: String, tasks: List[String]) = {
  val graph = cpg
  println("Applying default overlays")
  applyDefaultOverlays(graph)

  // dst -> src Set
  val ddgMap = mutable.Map[StoredNode, Set[StoredNode]]()

  graph.method.foreach(method => {
    val problem = APReachingDefProblem.create(method)
    val solution = new DataFlowSolver().calculateMopSolutionForwards(problem)
    val dataflowIn = solution.in
    val allNodes = dataflowIn.keySet

    allNodes.foreach(n => {
      n match {
        case expr: Expression => {
          val parent = expr._astIn.iterator.next()
          // a = b, a, a
          var skip = false
          parent match {
            case call: Call => {
              val name = call.name
              if (name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") || name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement")) {
                if (call.argument(1) == expr) {
                  skip = true
                }
              }
            }
            case _ => {}
          }

          if (!skip) {
            // 
            val in = dataflowIn.getOrElse(expr, Map.empty)
            // access path
            val apElements = getAPElements(expr)
            val ap = AccessPath(apElements, Seq.empty)
            // ap, 
            val defs = in.getOrElse(ap, Set.empty)
            defs.foreach(defLoc => {
              val existingDefLocs = ddgMap.getOrElse(n, Set.empty)
              ddgMap.update(n, existingDefLocs + defLoc)
            })
          }
        }
        case _ => {
          // println("Not matched ")
        }
      }
    })
  })

  val sharedVars = getSharedVariables(projectName, graph, tasks)
  // val sharedVars = getAllGlobalVars(graph).toSet

  val statistics = Statistics(
    globalVar = getAllGlobalVars(graph).toSet.size,
    sharedVar = sharedVars.size
  )
  
  val (var2Pairs, nodeSourceMap) = getVariableCorrelation(graph, ddgMap.toMap, sharedVars, statistics)
  val result = removeDuplicate(var2Pairs)
  // Pre-compute top-level callers cache: one reverse-CG traversal per unique function name
  val allFuncNames = result.keySet.map(_.method.name).toSet
  val callerCache: Map[String, List[String]] = allFuncNames.map(fn =>
    fn -> getTopLevelCallers(projectName, fn)
  ).toMap
  val resJson = buildVariableCorrelationJson(projectName, result, statistics, nodeSourceMap, callerCache)
  val res = toJsonPretty(resJson) 
  res
}

def isGlobalVar(l: Local) = {
  l.method.name.contains("<global>") && l.typeFullName != "struct"
}

def getAllGlobalVars(graph: Cpg) = {
  graph
    .local
    .filter(isGlobalVar)
    .name
    .toList
}

// ── Local variable scoping helpers for SMT encoding ──
// When the same local variable name (e.g., `i`) exists in multiple functions,
// they must be mapped to distinct SMT symbols to avoid false constraint conflicts.
// Global variables keep their original names for cross-path coupling.

val C_KEYWORDS = Set(
  "if", "else", "while", "for", "do", "switch", "case", "default",
  "break", "continue", "return", "goto", "sizeof", "typedef",
  "struct", "union", "enum", "volatile", "const", "static", "extern",
  "register", "auto", "inline", "void", "int", "char", "short", "long",
  "float", "double", "signed", "unsigned", "bool", "_Bool",
  "TRUE", "true", "FALSE", "false", "NULL", "nullptr"
)

// Regex matching C identifiers, including dotted/arrow struct field access chains
// e.g., matches "i", "flag_check_sram", "s.field", "ptr->member", "a.b.c"
val C_IDENT_CHAIN_RE = """([a-zA-Z_][a-zA-Z0-9_]*(?:(?:\.|-\>)[a-zA-Z_][a-zA-Z0-9_]*)*)""".r

/**
 * Check if a variable name (possibly a struct field chain like "s.field")
 * refers to a global variable. For simple names, check globalVars directly.
 * For struct field chains, check the root name (before first . or ->).
 */
def isGlobalOrSpecial(varName: String, globalVars: Set[String]): Boolean = {
  if (varName.contains("__")) return true // already scoped
  // For struct field chains, extract root
  val root = varName.split("""[\.\-]""")(0)
  globalVars.contains(root) || globalVars.contains(varName)
}

/**
 * Scope a variable name: if it's a local variable (not in globalVars),
 * prefix with methodName__ to make it unique across functions.
 * For struct field chains like "s.field", scopes the root: "main__s.field".
 */
def scopeVarName(varName: String, methodName: String, globalVars: Set[String]): String = {
  if (isGlobalOrSpecial(varName, globalVars)) {
    varName // global or already scoped — keep as-is
  } else {
    // For struct chains, prefix the root
    s"${methodName}__${varName}"
  }
}

/**
 * Scope local variable references in a condition expression string.
 * e.g., "i < 17" in function "main" becomes "main__i < 17"
 * Handles struct field chains: "s.field == 0" becomes "main__s.field == 0"
 * Global variables and C keywords are left unchanged.
 */
def scopeExpressionVars(expr: String, methodName: String, globalVars: Set[String]): String = {
  C_IDENT_CHAIN_RE.replaceAllIn(expr, m => {
    val ident = m.group(1)
    val root = ident.split("""[\.\-]""")(0)
    if (C_KEYWORDS.contains(root) || isGlobalOrSpecial(ident, globalVars)) {
      java.util.regex.Matcher.quoteReplacement(ident)
    } else {
      java.util.regex.Matcher.quoteReplacement(s"${methodName}__${ident}")
    }
  })
}

/**
 * Post-process a cfgReachability result to scope local variables.
 * Modifies the JSON in-place: scopes assignment variable names and
 * condition expression strings for local variables.
 */
def scopeResultLocals(result: Obj, methodName: String, globalVars: Set[String]): Unit = {
  if (globalVars.isEmpty) return // No scoping info available

  // Scope assignments
  for (a <- result.obj.getOrElse("assignments", Arr()).arr) {
    val varName = a("variable").str
    a("variable") = ujson.Str(scopeVarName(varName, methodName, globalVars))
  }

  // Scope path conditions
  for (c <- result.obj.getOrElse("conditions", Arr()).arr) {
    val expr = c("expression").str
    c("expression") = ujson.Str(scopeExpressionVars(expr, methodName, globalVars))
  }

  // Scope enclosing conditions
  for (c <- result.obj.getOrElse("enclosing_conditions", Arr()).arr) {
    val expr = c("expression").str
    c("expression") = ujson.Str(scopeExpressionVars(expr, methodName, globalVars))
  }
}

/**
 * Scope local variables in a list of condition tuples (expression, branch, line)
 * and return a new scoped list.
 */
def scopeConditionTuples(
  conditions: List[(String, String, Int)],
  methodName: String,
  globalVars: Set[String]
): List[(String, String, Int)] = {
  if (globalVars.isEmpty) return conditions
  conditions.map { case (expr, branch, line) =>
    (scopeExpressionVars(expr, methodName, globalVars), branch, line)
  }
}

// funName
def getRelatedFuncs(cg: Map[String, Set[String]], funName: String) : Set[String] = {
  val relatedFunResult = mutable.Set[String]()

  val visited = mutable.Set[String]()
  val queue = mutable.Queue[String]()

  queue.enqueue(funName)
  visited += funName

  while (queue.nonEmpty) {
    val curFun = queue.dequeue()
    relatedFunResult += curFun

    cg.getOrElse(curFun, Set.empty).foreach(callee => {
      if (!visited.contains(callee)) {
        queue.enqueue(callee)
        visited += callee
      }
    })
  }

  relatedFunResult.toSet
}

def getSharedVariables(projectName: String, cpg: Cpg, tasks: List[String]): Set[String] = {
  val allGlobalVars = getAllGlobalVars(cpg).toSet

  val cg : Map[String, Set[String]] = getCallGraph(cpg).toMap

  val task2RelatedFuncs = tasks.map(task => (task, getRelatedFuncs(cg, task))).toMap
  // task
  val task2GlobalVars = task2RelatedFuncs.map((task, relatedFuncs) => {
    val allRelatedGlobalVars = relatedFuncs.flatMap(relatedFun => {
      // NOTE on L1-07 (local variable shadowing):
      // Ideally we would filter identifiers that shadow globals with local declarations.
      // However, Joern's CPG for C code parsed without compile_commands.json creates
      // Local nodes for ALL identifiers (including global variable references), making
      // cpg.method().local.name and refOut-based filtering unreliable — both approaches
      // incorrectly classify global variables as locals, removing all shared variables.
      // Therefore we use simple name-based intersection without shadowing filter.
      // This means true local shadowing (rare in embedded C) may cause false positives,
      // which are acceptable given the alternative of systematic false negatives.
      val allIdentifiers = cpg.method(relatedFun).ast.isIdentifier.name.toSet
      val funGlobalVars = allGlobalVars.intersect(allIdentifiers)
      funGlobalVars
    })
    (task, allRelatedGlobalVars)
  })

  val result = mutable.Set[String]()
  for (i <- tasks.indices) {
    val taskGlobalVars1 = task2GlobalVars.getOrElse(tasks(i), Set.empty)
    for (j <- (i+1) until tasks.length) {
      val taskGlobalVars2 = task2GlobalVars.getOrElse(tasks(j), Set.empty)
      val intersected = taskGlobalVars1.intersect(taskGlobalVars2)
      result.addAll(intersected)
    }
  }
  result.toSet
}

class Statistics(
  var globalVar: Int = 0,
  var sharedVar: Int = 0,
  var saa: Int = 0, var dfc_tup: Int = 0, var sink: Int = 0, var update: Int = 0, var dac: Int = 0,
  var pairs: Int = 0, var dfc_tup_pairs: Int = 0, var sink_pairs: Int = 0, var update_pairs: Int = 0, var dac_pairs: Int = 0
)

def collectVariable(tree: CfgNode, globalVars: Set[String],
                    ddgMap: Map[StoredNode, Set[StoredNode]],
                    path: mutable.ListBuffer[CfgNode],
                    considerDdg: Boolean = true,
                    considerAssignmentLeft: Boolean = false,
                    visited: mutable.Set[AnyRef] = mutable.Set.empty) : List[(String, VariableTrace)] = {
  if (tree.isInstanceOf[Method]) {
    return List.empty
  }

  val allVars = mutable.ListBuffer[(String, VariableTrace)]()
  // a.b.e[i].x, 
  var fieldAccessAlready = false
  
  tree match {
    case id: Identifier => {
      // 
      if (globalVars.contains(id.name)) {
        val baseTrace = path.toList
        val traceNodes =
          if (baseTrace.nonEmpty && baseTrace.last == id) baseTrace
          else baseTrace :+ id
        allVars.addOne(id.name, VariableTrace(id, traceNodes))
      }
    }
    case call: Call => {
      val name = call.name
      if (name == Operators.fieldAccess || name == Operators.indirectFieldAccess || name == Operators.indexAccess || name == Operators.indirectIndexAccess || name == Operators.indirection) {
        val apElems = getAPElements(call)
        if (!apElems.isEmpty && globalVars.contains(apElems.elements(0).toString)) {
          val baseTrace = path.toList
          val traceNodes =
            if (baseTrace.nonEmpty && baseTrace.last == call) baseTrace
            else baseTrace :+ call
          // For indirection (*ptr), use base name instead of call.code which includes "*"
          val varKey = if (name == Operators.indirection) apElems.elements(0).toString else call.code
          allVars.addOne(varKey, VariableTrace(call, traceNodes))
          fieldAccessAlready = true
        }
      }
    }
    case _ => { }
  }

  // 
  val inNodes = ddgMap.getOrElse(tree, Set.empty).filterNot(x => x.isInstanceOf[Method])

  if (inNodes.nonEmpty && considerDdg) {
    // 1. 
    inNodes.foreach(inNode => {
      inNode match {
        case node: CfgNode => {
          // , 
          // , 
          var needToFilter = true
          node match {
            case c: Call => {
              val name = c.name
              if (name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") || name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement")) {
                // 
                needToFilter = false
              }
            }
            case _ => {  }
          }
          if (tree.astChildren.contains(node)) {
            needToFilter = false
          }

          if (!needToFilter) {
            // , newPath
            val newPath = mutable.ListBuffer[CfgNode]()
            newPath.addAll(path)
            newPath.addOne(tree)
            newPath.addOne(node)
            if (!visited.contains(node)) {
              visited += node
              allVars.addAll(collectVariable(node, globalVars, ddgMap, newPath, considerDdg, considerAssignmentLeft, visited))
              visited -= node
            }
          }
        }
      }
    })
  } else if (!fieldAccessAlready) {
    // 2. ast
    tree.astChildren.foreach(child => {
      child match {
        case childNode: CfgNode => {
          // a = b, , 
          var skip = false
          tree match {
            case call: Call => {
              val name = call.name
              if (name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") || name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement")) {
                if (call.argument(1) == childNode) {
                  skip = true
                }
              }
            }
            case _: Block => {
              skip = true
            }
            case _ => {}
          }

          if (!skip || considerAssignmentLeft) {
            if (!visited.contains(childNode)) {
              visited += childNode
              allVars.addAll(collectVariable(childNode, globalVars, ddgMap, path, considerDdg, considerAssignmentLeft, visited))
              visited -= childNode
            }
          }
        }
        case _: Local => { }
      }
    })
  }

  allVars.toList
}

def combine(var2PathList : mutable.ListBuffer[List[(String, VariableTrace)]]) : List[Map[String, VariableTrace]] = {
  var prefix = mutable.ListBuffer[Map[String, VariableTrace]]()
  var2PathList.foreach(curVar2Path => {
    val combineResult = mutable.ListBuffer[Map[String, VariableTrace]]()
    if (prefix.isEmpty) {
      // curVar2Path: {a, b, c} ==> { {a}, {b}, {c} }
      curVar2Path.foreach((v, trace) => {
        val one = mutable.Map[String, VariableTrace]()
        one.addOne((v, trace))
        combineResult.addOne(one.toMap)
      })
    } else {
      // prefix: { {a, b}, {c, d}, {c, e} }
      // curVar2Path: {g, h, i}
      // result: foreach p in prefix: 
      //            foreach c in curVar2Path
      //                p + c
      //                {a, b} + {g} => {a, b, g}
      prefix.foreach(oneCombine => {
        curVar2Path.foreach((v, trace) => {
          val finalCombine = mutable.Map[String, VariableTrace]()
          finalCombine.addAll(oneCombine)
          finalCombine.addOne((v, trace))
          combineResult.addOne(finalCombine.toMap)
        })
      })
    }
    val MAX_COMBINE = 500
    if (combineResult.size > MAX_COMBINE) {
      println(s"[WARN] combine: truncating ${combineResult.size} → $MAX_COMBINE combinations")
      prefix = combineResult.take(MAX_COMBINE)
    } else {
      prefix = combineResult
    }
  })

  val prefixTmpResult = prefix.filterNot(oneCombine => oneCombine.size<=1).toList
  
  // 
  /*
  {a, b}, {b, a}, {c, d}, {d, c}, {e, f}, {f, e}
  : {a, b}, {c, d}, {e, f} 
  */
  val finalResult = mutable.ListBuffer[Map[String, VariableTrace]]()
  
  val keySet = mutable.Set[Seq[String]]()
  prefixTmpResult.foreach(oneCombine => {
    // {a, b}
    val keys = oneCombine.map { case (variableName, trace) => {
      // file.c@L10, g1
      trace.node.file.next().name + "@L" + trace.node.lineNumber.getOrElse(0) + "," + variableName
    }
    }.sorted
    // val keys = oneCombine.keySet.sorted
    // keySet{a, b}, 
    // 
    if (!keySet.contains(keys)) {
      keySet.addOne(keys)
      finalResult.addOne(oneCombine)
    }
  })
  
  //  ()
  /*
   L1: if (*) a = g1;
   L2: if (*) a = g2;
   L3: (a == False) || (a == True)
   <g1, g2>, trace:
   TraceA:
    L3: a == False
    L3: a               <-------
    L2: a = g2
   TraceB:
    L3: a == True
    L3: a               <------- same code
    L1: a = g1
  */
  val finalResult1 = finalResult.filterNot(varKey2Trace => {
    val secondCodes = varKey2Trace.collect{
      case (_, trace) if trace.trace.length >= 2 => trace.trace(1).code
    }
    secondCodes.groupBy(identity)
      .exists{ case (_, group) => group.size > 1 }
  })

  finalResult1.toList
}

def removeDuplicate(varPairsMap: Map[CfgNode, List[Map[String, VariableTrace]]]) : Map[CfgNode, List[Map[String, VariableTrace]]] = {
  val result = mutable.Map[CfgNode, List[Map[String, VariableTrace]]]()
  /*
  // [
  //   {
  //     g1: "L7,L6,L5",
  //     g2: "L7,L6,L5"
  //   },
  //   {
  //     g1, "L8,L7,L6,L5",
  //     g2, "L8,L7,L6,L5"
  //   }
  // ]
  keys, keyvaluevalue, 
  */
  val forDuplicate = mutable.Map[Set[String], mutable.ListBuffer[Map[String, String]]]()

  val sortedEntries = varPairsMap.toList.sortBy { case (cfgNode, _) => (
      cfgNode.file.next().name,
      cfgNode.lineNumber.getOrElse(0)
    )
  }
  sortedEntries.foreach{case (interestNode, variablePairMapList) => {
    variablePairMapList.foreach(variablePairMap => {
      // 
      val variableSet = variablePairMap.map{case (variableName, variableTrace) => {
        // file.c@L10, g1
        val node = variableTrace.node
        node.file.next().name + "@L" + node.lineNumber.getOrElse(0) + "," + variableName
      }}.toSet

      //
      val candidateVar2TraceList = forDuplicate.getOrElse(variableSet, mutable.ListBuffer.empty)

      var allMatched = false
      candidateVar2TraceList.foreach(candidateVar2Trace => {

        // 
        var matched = true
        variablePairMap.foreach{ case (variableName, variableTrace) =>
          // variableName: g1
          // traceLineNumberStr: "L8,L7,L6,L5"
          val node = variableTrace.node
          val fullVariableName = node.file.next().name + "@L" + node.lineNumber.getOrElse(0) + "," + variableName
          val traceLineStr = variableTrace.trace.map(traceNode => "L" + traceNode.lineNumber.getOrElse(0)).mkString(",")

          // Exact match: two traces are duplicates only when they have identical
          // line sequences. The previous endsWith check incorrectly treated a longer
          // trace "L15,L9" as a duplicate of a shorter "L9" when the longer trace
          // has a completely different data-flow origin (L15 assignment vs. unknown).
          val candidateTraceLineStr = candidateVar2Trace.getOrElse(fullVariableName, "~")
          if (traceLineStr != candidateTraceLineStr) {
            matched = false
          }
        }

        allMatched |= matched
      })

      if (!allMatched) {
        val resultVarPairList = result.getOrElse(interestNode, List.empty)
        result.update(interestNode, resultVarPairList :+ variablePairMap)

        val previousResult = variablePairMap.map { case (variableName, variableTrace) =>
          (
            variableTrace.node.file.next().name + "@L" + variableTrace.node.lineNumber.getOrElse(0) + "," + variableName,
            variableTrace.trace.map(traceNode => "L" + traceNode.lineNumber.getOrElse(0)).mkString(",")
          )
        }
        forDuplicate.getOrElseUpdate(variableSet, mutable.ListBuffer.empty) += previousResult
      }
    })
  }}
  result.toMap
}

/**
 * 
 * 
 * 
 * @param expr 
 * @param cpg 
 * @return  true
 */
def isConstant(expr: Expression, macroNames: Set[String]): Boolean = {
  expr match {
    case _: Literal => {
      // 
      true
    }
    case id: Identifier => {
      // 
      val name = id.name
      
      // 1:  isInline  Call 
      //  CPG 
      val isMacro = macroNames.contains(name)
      
      // 2: 
      val isEnum = Try {
        val typeName = id.typeFullName
        typeName.toLowerCase.contains("enum") || 
        typeName.matches(".*enum.*") ||
        // 
        id.refOut.exists {
          case member: Member => member.typeDecl.exists(_.name.toLowerCase.contains("enum"))
          case _ => false
        }
      }.getOrElse(false)
      
      // 3: ALL_CAPS naming convention or const-qualified type
      val looksLikeConstant = name.matches("^[A-Z][A-Z0-9_]*$") && name.length > 1
      val hasNoRefs = !id.refOut.hasNext

      // 3b: const-qualified variable (e.g., `const int maxSpeed = 200;`)
      val isConstQualified = Try {
        id.refOut.exists {
          case local: Local => local.typeFullName.contains("const ")
          case member: Member => member.typeFullName.contains("const ")
          case _ => false
        }
      }.getOrElse(false)
      
      // 4:  NULLTRUEFALSE 
      val isSpecialConstant = name == "NULL" || name == "null" || 
                              name == "TRUE" || name == "FALSE" ||
                              name == "true" || name == "false" ||
                              name == "EOF" || name == "stdin" || name == "stdout" || name == "stderr"
      
      // 5:  __LINE__, __FILE__ 
      val isCompileTimeConst = name.startsWith("__") && 
                               (name == "__LINE__" || name == "__FILE__" || 
                                name == "__DATE__" || name == "__TIME__" ||
                                name == "__FUNCTION__" || name == "__func__")
      
      isMacro || isEnum || (looksLikeConstant && hasNoRefs) || isConstQualified || isSpecialConstant || isCompileTimeConst
    }
    case call: Call => {
      // 
      if (call.isInline) {
        true
      } else {
        //  sizeof, offsetof 
        val constOps = Set("sizeof", "offsetof", "__builtin_constant_p", 
                          "__builtin_choose_expr", "__builtin_types_compatible_p")
        call.name.exists(constOps.contains)
      }
    }
    case _ => false
  }
}

/**
 * ""
 * : g1 == 0, g2 > 10, status != NULL, mode == STATE_IDLE 
 * 
 * @param expr 
 * @param cpg 
 * @return  (, , ) Option
 */
def isComparisonWithConstant(expr: Expression, macroNames: Set[String]): Option[(Call, Expression, Expression)] = {
  expr match {
    case call: Call => {
      val callName = call.name
      // 
      if (callName == Operators.equals || 
          callName == Operators.notEquals ||
          callName == Operators.greaterThan ||
          callName == Operators.lessThan ||
          callName == Operators.greaterEqualsThan ||
          callName == Operators.lessEqualsThan) {
        // 
        if (call.argument.size >= 2) {
          val left = call.argument(1)
          val right = call.argument(2)
          
          // 
          val leftIsConst = isConstant(left, macroNames)
          val rightIsConst = isConstant(right, macroNames)
          
          if (leftIsConst && !rightIsConst) {
            Some((call, right, left))  // 
          } else if (!leftIsConst && rightIsConst) {
            Some((call, left, right))  // 
          } else {
            None  // 
          }
        } else {
          None
        }
      } else {
        // 
        call.astChildren.collectFirst {
          case child: Expression => isComparisonWithConstant(child, macroNames)
        }.flatten
      }
    }
    case _ => None
  }
}

/**
 * 
 * 
 * 
 */
def collectVariablesComparedWithConstant(control: Expression, allGlobalVars: Set[String],
                                         ddgMap: Map[StoredNode, Set[StoredNode]],
                                         macroNames: Set[String]): List[(String, VariableTrace)] = {
  val result = mutable.ListBuffer[(String, VariableTrace)]()
  
  // ""
  isComparisonWithConstant(control, macroNames) match {
    case Some((compCall, varSide, constSide)) => {
      // 
      varSide match {
        case varSideNode: CfgNode => {
          val path = mutable.ListBuffer[CfgNode]()
          path.addOne(control.asInstanceOf[CfgNode])
          path.addOne(compCall)
          path.addOne(varSideNode)
          val var2Path = collectVariable(varSideNode, allGlobalVars, ddgMap, path, false, true)
          result.addAll(var2Path)
        }
        case _ => {}
      }
    }
    case None => {
      control match {
        case call: Call => {
          val callName = call.name
          // Handle && and || by recursing into sub-expressions
          if (callName == Operators.logicalAnd || callName == Operators.logicalOr) {
            call.argument.foreach(arg => {
              arg match {
                case argExpr: Expression => {
                  result.addAll(collectVariablesComparedWithConstant(argExpr, allGlobalVars, ddgMap, macroNames))
                }
                case _ => {}
              }
            })
          } else if (callName == Operators.logicalNot) {
            // !flag — extract the negated operand as implicit boolean test
            call.argument.headOption match {
              case Some(inner: Identifier) if allGlobalVars.contains(inner.name) => {
                val path = mutable.ListBuffer[CfgNode]()
                path.addOne(control.asInstanceOf[CfgNode])
                path.addOne(call)
                path.addOne(inner)
                result.addOne(inner.name, VariableTrace(inner, path.toList))
              }
              case _ => {}
            }
          }
        }
        // Bare identifier: if (flag) — implicit flag != 0
        case id: Identifier if allGlobalVars.contains(id.name) => {
          val path = mutable.ListBuffer[CfgNode]()
          path.addOne(control.asInstanceOf[CfgNode])
          path.addOne(id)
          result.addOne(id.name, VariableTrace(id, path.toList))
        }
        case _ => {}
      }
    }
  }
  
  result.toList
}

def getVariableCorrelation(graph: Cpg, ddgMap: Map[StoredNode, Set[StoredNode]], allGlobalVars: Set[String], statistics: Statistics) = {
  val inlineMacroNames: Set[String] = Try {
    graph.call.filter(_.isInline).name.toSet
  }.getOrElse(Set.empty)
  val condList = graph.controlStructure.condition.toList
  // cfgNode -> var -> path
  val varPairsMap = mutable.Map[CfgNode, List[Map[String, VariableTrace]]]()
  // Track source dimension for each CfgNode: "sink" | "update" | "dac"
  val nodeSourceMap = mutable.Map[CfgNode, String]()

  condList.foreach {
    case call: Call => {
      // a <= b,(c+b) <= d
      if (call.argument.size >= 2) {
        // 
        val var2PathList = mutable.ListBuffer.empty[List[(String, VariableTrace)]]

        call.argument.foreach(arg => {
          val path = mutable.ListBuffer[CfgNode]()
          path.addOne(arg)
          val var2Path = collectVariable(arg, allGlobalVars, ddgMap, path)

          if (var2Path.nonEmpty) {
            var2PathList.addOne(var2Path)
          }
        })

        val combineList = combine(var2PathList)
        if (combineList.nonEmpty) {
          varPairsMap.addOne(call, combineList)
          nodeSourceMap.getOrElseUpdate(call, "sink")

          statistics.saa += 1
          statistics.dfc_tup += 1
          statistics.sink += 1

          statistics.pairs += combineList.size
          statistics.dfc_tup_pairs += combineList.size
          statistics.sink_pairs += combineList.size
        }
      }
    }
    case _ => {  }
  }

  graph.call.foreach(call => {
    call.name match {
      case Operators.addition | Operators.subtraction | Operators.multiplication | Operators.division => {
        // 
        val var2PathList = mutable.ListBuffer.empty[List[(String, VariableTrace)]]

        val inNodes = ddgMap.getOrElse(call, Set.empty).filterNot(x => x.isInstanceOf[Method])
        if (inNodes.isEmpty) {
          call.argument.foreach(arg => {
            arg match {
              case arg: CfgNode => {
                val path = mutable.ListBuffer[CfgNode]()
                path.addOne(arg)
                val var2Path = collectVariable(arg, allGlobalVars, ddgMap, path)
                if (var2Path.nonEmpty) {
                  var2PathList.addOne(var2Path)
                }
              }
            }
          })
        } else {
          inNodes.foreach(inNode => {
            inNode match {
              case arg: CfgNode => {
                val path = mutable.ListBuffer[CfgNode]()
                path.addOne(arg)
                val var2Path = collectVariable(arg, allGlobalVars, ddgMap, path)

                if (var2Path.nonEmpty) {
                  var2PathList.addOne(var2Path)
                }
              }
            }
          })
        }

        val combineList = combine(var2PathList)
        if (combineList.nonEmpty) {
          varPairsMap.addOne(call, combineList)
          nodeSourceMap.getOrElseUpdate(call, "sink")

          statistics.saa += 1
          statistics.dfc_tup += 1
          statistics.sink += 1

          statistics.pairs += combineList.size
          statistics.dfc_tup_pairs += combineList.size
          statistics.sink_pairs += combineList.size
        }
      }
      case _ => { }
    }
  })

  // D3: Function call arguments — global variables passed to the same function call
  // are correlated (they flow into the same computation context)
  graph.call
    .filterNot(c => c.name.startsWith("<operator>") || c.name.startsWith("<operators>"))
    .filterNot(_.isInline)
    .foreach(call => {
      val var2PathList = mutable.ListBuffer.empty[List[(String, VariableTrace)]]

      call.argument.foreach(arg => {
        arg match {
          case argNode: CfgNode => {
            val path = mutable.ListBuffer[CfgNode]()
            path.addOne(argNode)
            val var2Path = collectVariable(argNode, allGlobalVars, ddgMap, path)
            if (var2Path.nonEmpty) {
              var2PathList.addOne(var2Path)
            }
          }
          case _ => {}
        }
      })

      // Need variables from at least 2 different arguments
      if (var2PathList.size >= 2) {
        val combineList = combine(var2PathList)
        if (combineList.nonEmpty && !varPairsMap.contains(call)) {
          varPairsMap.addOne(call, combineList)
          nodeSourceMap.getOrElseUpdate(call, "sink")

          statistics.saa += 1
          statistics.dfc_tup += 1
          statistics.sink += 1

          statistics.pairs += combineList.size
          statistics.dfc_tup_pairs += combineList.size
          statistics.sink_pairs += combineList.size
        }
      }
    })

  // D4: Basic-block consecutive global writes — global variables written
  // within the same basic block and within MAX_WRITE_GAP lines form a
  // transactional update group. The old logic only caught same-AP-root
  // field assignments; this generalized version catches all adjacent
  // global writes including independent variables.
  val MAX_WRITE_GAP = 5

  cpg.method.filter(isUserMethod).foreach(method => {
    val bbs = getBasicBlocks(method)
    bbs.foreach(bb => {
      // Collect all global variable write nodes in this basic block, sorted by line
      val globalWrites = mutable.ListBuffer[(String, CfgNode, Int)]() // (varCode, node, line)
      bb.foreach(n => {
        n match {
          case call: Call => {
            val name = call.name
            if (name.startsWith("<operator>.assignment") || name.startsWith("<operators>.assignment") ||
                name.equals("<operator>.postDecrement") || name.equals("<operator>.postIncrement")) {
              val left = call.argument(1)
              val apElems = getAPElements(left)
              if (!apElems.isEmpty) {
                val apRootStr = apElems.elements(0).toString
                if (allGlobalVars.contains(apRootStr) || Try(Integer.decode(apRootStr)).isSuccess) {
                  val line = n.lineNumber.getOrElse(0)
                  globalWrites.addOne((left.code, n, line))
                }
              }
            }
          }
          case _ => {}
        }
      })

      // Sliding window: enumerate ALL variable pairs within MAX_WRITE_GAP lines.
      // Previously only paired adjacent writes (i, i+1), missing non-adjacent pairs
      // when an unrelated global write intervenes (e.g., Time.S / counter / Time.MS
      // would miss the Time.S↔Time.MS pair). Now we enumerate all combinations(2)
      // within each window position to capture all valid transactional pairs.
      if (globalWrites.size >= 2) {
        val sorted = globalWrites.sortBy(_._3)
        var pairsAdded = 0
        val emittedPairs = mutable.Set[String]() // deduplicate (varA, varB) pairs within this BB

        for (i <- sorted.indices) {
          for (j <- (i + 1) until sorted.size) {
            val (codeI, nodeI, lineI) = sorted(i)
            val (codeJ, nodeJ, lineJ) = sorted(j)

            // Both writes must be within MAX_WRITE_GAP lines
            if (lineJ - lineI <= MAX_WRITE_GAP && codeI != codeJ) {
              // Deduplicate: same variable pair in same BB only emitted once
              val pairKey = if (codeI < codeJ) s"$codeI|$codeJ" else s"$codeJ|$codeI"
              if (!emittedPairs.contains(pairKey)) {
                emittedPairs += pairKey

                val oneCombine = Map(
                  codeI -> VariableTrace(nodeI, List(nodeI)),
                  codeJ -> VariableTrace(nodeJ, List(nodeJ))
                )
                if (oneCombine.size > 1) {
                  val anchorNode = nodeI
                  val combines = varPairsMap.getOrElse(anchorNode, List.empty)
                  varPairsMap(anchorNode) = combines :+ oneCombine
                  nodeSourceMap.getOrElseUpdate(anchorNode, "update")

                  statistics.pairs += 1
                  statistics.dfc_tup_pairs += 1
                  statistics.update_pairs += 1
                  pairsAdded += 1
                }
              }
            }
          }
        }
        if (pairsAdded > 0) {
          statistics.saa += 1
          statistics.dfc_tup += 1
          statistics.update += 1
        }
      }
    })
  })
  
  // 
  graph.controlStructure.foreach(controlStructure => {
    controlStructure.condition.foreach(control => {
      //   // 
      // val path = mutable.ListBuffer[CfgNode]()
      // path.addOne(control)
      // val controlVar2Path = collectVariable(control, allGlobalVars, ddgMap, path, false, true)
      // 
      // 
      val controlVar2Path = collectVariablesComparedWithConstant(control, allGlobalVars, ddgMap, inlineMacroNames)

      if (controlVar2Path.nonEmpty) {

        val childrenList = controlStructure.astChildren.toList
        val childrenSubList = childrenList.slice(1, childrenList.length)

        /*
        val controlledList = control.controls.toList
        val controlledCallList = controlledList.filter(_.isCall)
        */

        // Track whether this control structure produced any DAC pairs,
        // so we count saa only once per control node (not per child).
        var controlProducedDac = false

        childrenSubList.foreach(controlled => {
          val controlledNode = controlled.asInstanceOf[CfgNode]
          val var2PathList = mutable.ListBuffer[List[(String, VariableTrace)]]()

          val path1 = mutable.ListBuffer[CfgNode]()
          val controlledVar2Path = collectVariable(controlledNode, allGlobalVars, ddgMap, path1, false, true)
          if (controlledVar2Path.nonEmpty) {
            var2PathList.addOne(controlVar2Path)
            var2PathList.addOne(controlledVar2Path)
            val combineList = combine(var2PathList)
            if (combineList.nonEmpty) {
              val existing = varPairsMap.getOrElse(control, List.empty)
              varPairsMap.addOne(control, existing ++ combineList)
              nodeSourceMap.getOrElseUpdate(control, "dac")

              statistics.dac += 1
              statistics.pairs += combineList.size
              statistics.dac_pairs += combineList.size
              controlProducedDac = true
            }
          }
        })
        // Count saa once per control structure, not per child
        if (controlProducedDac) {
          statistics.saa += 1
        }
      }
    })
  })

  (varPairsMap.toMap, nodeSourceMap.toMap)
}

/**
 * MethodBasicBlock
 *
 * @param method Method
 * @return List[List[CfgNode]]List[CfgNode]BasicBlock
 */
def getBasicBlocks(method: Method): List[List[CfgNode]] = {
  val cfg = CfgGenerator().generate(method)
  var predMap = Map[CfgNode, List[CfgNode]]()
  var succMap = Map[CfgNode, List[CfgNode]]()
  cfg.vertices.foreach(n => {
    predMap += (n.asInstanceOf[CfgNode], List.empty)
    succMap += (n.asInstanceOf[CfgNode], List.empty)
  })
  cfg.edges.foreach(edge => {
    val preds = predMap.getOrElse(edge.dst.asInstanceOf[CfgNode], List.empty)
    predMap = predMap.updated(edge.dst.asInstanceOf[CfgNode], edge.src.asInstanceOf[CfgNode] :: preds)

    val succs = succMap.getOrElse(edge.src.asInstanceOf[CfgNode], List.empty)
    succMap = succMap.updated(edge.src.asInstanceOf[CfgNode], edge.dst.asInstanceOf[CfgNode] :: succs)
  })

  /**
   * 
   */
  def identifyEntryNodes(method: Method, allCfgNodes: Set[CfgNode]): List[CfgNode] = {
    if (succMap(method).isEmpty) return List.empty
    // 
    val methodEntry = List(succMap(method).head)

    // 
    val multiplePredecessors = allCfgNodes.filter {
      node => predMap(node).size > 1
    }

    // 
    val branchTargets = allCfgNodes.filter {
      node =>
        // 
        predMap(node).exists(prev => isBranchNode(prev))
    }

    // 
    (methodEntry ++ multiplePredecessors ++ branchTargets).distinct
  }

  /**
   * 
   */
  def isBranchNode(node: CfgNode): Boolean = {
    // 
    succMap(node).size > 1
  }

  /**
   * 
   */
  def buildBasicBlock(entryNode: CfgNode, allCfgNodes: Set[CfgNode]): List[CfgNode] = {
    var currentNode = entryNode
    var block = List(entryNode)

    // 
    while (true) {
      val successors = succMap(currentNode)

      // 
      if (successors.isEmpty) {
        return block
      }

      // 
      if (successors.size > 1) {
        return block
      }

      val nextNode = successors.head

      // 
      if (isEntryNode(nextNode, allCfgNodes)) {
        return block
      }

      // 
      block = block :+ nextNode
      currentNode = nextNode
    }

    block // 
  }

  /**
   * 
   */
  def isEntryNode(node: CfgNode, allCfgNodes: Set[CfgNode]): Boolean = {
    // 
    if (predMap(node).size > 1) {
      return true
    }

    // 
    if (predMap(node).exists(prev => isBranchNode(prev))) {
      return true
    }

    false
  }

  // CFG
  val allCfgNodes = cfg.vertices.map(_.asInstanceOf[CfgNode]).toSet

  // 1. 
  val entryNodes = identifyEntryNodes(method, allCfgNodes)

  // 2. 
  entryNodes.map(entryNode => buildBasicBlock(entryNode, allCfgNodes))
    .sortBy(bb => bb.head.lineNumber.getOrElse(0))
}

/** 
 *  JSON 
 */
def toJsonPretty(value: Value): String = value.render(indent = 2)

def buildVariableCorrelationJson(
    projectName: String,
    varPairsMap: Map[CfgNode, List[Map[String, VariableTrace]]],
    statistics: Statistics,
    nodeSourceMap: Map[CfgNode, String] = Map.empty,
    callerCache: Map[String, List[String]] = Map.empty
): Value = {
  val accessLists = Arr()

  varPairsMap.foreach { case (cfgNode, var2PathMaps) =>
    val fileTraversal = cfgNode.file
    val filePath = if (fileTraversal.hasNext) fileTraversal.next().name else ""
    val functionName = cfgNode.method.name
    val fallbackLine = cfgNode.lineNumber.getOrElse(0)
    val fallbackColumn = cfgNode.columnNumber.getOrElse(0)
    val entryNames = callerCache.getOrElse(functionName, getTopLevelCallers(projectName, functionName))
    // Look up the source dimension tag for this CfgNode
    val sourceTag = nodeSourceMap.getOrElse(cfgNode, "")
    var2PathMaps.foreach { var2PathMap =>
      val entryTuples = var2PathMap.toSeq.flatMap { case (variableKey, variableTrace) =>
        val effectiveEntryNames =
          if (entryNames.nonEmpty) entryNames else Seq(functionName)

        effectiveEntryNames.map { entryName =>
          val node = variableTrace.node

          // Determine access type (handles *ptr = value via grandparent walk-up)
          val READ_OR_WRITE = determineAccessType(node)

          val nodeLine = node.lineNumber.getOrElse(fallbackLine)
          val nodeColumn = node.columnNumber.getOrElse(fallbackColumn)
          val exprText = if (node.code != null && node.code.nonEmpty) node.code else variableKey
          val entryObj = Obj(
            "Entry" -> ujson.Str(entryName),
            "Function" -> functionName,
            "AccessType" -> READ_OR_WRITE,
            "FilePath" -> filePath,
            "Line" -> nodeLine,
            "Column" -> nodeColumn,
            "ExprText" -> exprText
          )
          // Add source dimension tag if available
          if (sourceTag.nonEmpty) {
            entryObj("Source") = ujson.Str(sourceTag)
          }
          (nodeLine, nodeColumn, entryObj)
        }
      }
      val groupEntries = entryTuples.sortBy { case (line, column, _) => (line, column) }.map(_._3)

      if (groupEntries.nonEmpty) {
        val groupArray = Arr()
        groupEntries.foreach(entry => groupArray.arr += entry)
        accessLists.arr += groupArray
      }
    }
  }

  Obj(
    "AccessLists" -> accessLists,
    "Stats" -> Obj(
      "globalVar" -> statistics.globalVar,
      "sharedVar" -> statistics.sharedVar,
      "saa" -> statistics.saa,
      "svc" -> statistics.dfc_tup,
      "sink" -> statistics.sink,
      "update" -> statistics.update,
      "dac" -> statistics.dac,
      "pairs" -> statistics.pairs,
      "svc_pairs" -> statistics.dfc_tup_pairs,
      // Note: JSON keys "svc" and "svc_pairs" kept for backward compatibility with Tool A parser
      "sink_pairs" -> statistics.sink_pairs,
      "update_pairs" -> statistics.update_pairs,
      "dac_pairs" -> statistics.dac_pairs
    )
  )
}

// ── DEBUG UTILITIES (not called from production code) ──
def dumpResult(varPairsMap : Map[CfgNode, List[Map[String, VariableTrace]]]): Unit = {
  val sortedEntries = varPairsMap.toList.sortBy { case (cfgNode, _) => (
      cfgNode.file.next().name,
      cfgNode.lineNumber.getOrElse(0)
    )
  }

  val lines = sortedEntries.map { node2VarPathList =>
      val variable = node2VarPathList._1
      val var2PathList = node2VarPathList._2

      val s = var2PathList.map(var2Path => {
          val pathElementsList = var2Path // List[PathElement]
          //  variable.toString  variable.name
          val variableName = "<" + var2Path.keySet.mkString(", ") + ">" //  variable.name

          //  path L10, val x = 1\nL11, x + 1
          val pathElementsStr: String = pathElementsList.map { ele => {
              val varName = ele._1
              val variableTrace = ele._2
              val traceNodes = variableTrace.trace
              varName + ": \n" + traceNodes.map(e => {
                val line = e.lineNumber.getOrElse(0)
                  val column = e.columnNumber.getOrElse(0)
                val code = e.code
                  s"  -> L$line:C$column: $code"
              }).mkString("\n")
            }
            }
            .mkString("\n") //  path 

          //  CSV
          val pathStr = pathElementsStr
          val representativeNode = var2Path.values.headOption.map(_.node).getOrElse(variable)
          val line = representativeNode.lineNumber.getOrElse(0)
          val column = representativeNode.columnNumber.getOrElse(0)
          s""""${representativeNode.file.next().name}","${representativeNode.method.name}","L$line:C$column","${representativeNode.code}","$variableName","$pathStr""""
        })
        .mkString("\n")
      s
    }
    .mkString("\n")


  println(lines)

  //  CSV 
  val writer = new PrintWriter("output.csv")
  writer.println("File,Function,Line,Statement,GlobalVars,Data Dependency")
  writer.println(lines)
  writer.close()
}


// ════════════════════════════════════════════════════
// SECTION 2: CPG QUERY UTILITIES
// ════════════════════════════════════════════════════
/**
 *  @return 5
 */
def getUpstreamCallers(projectName: String, funcName: String, filePath: String): List[String] = {
  val graph = cpg
  val target = graph.method.nameExact(funcName).filename(filePath).headOption
  if (target.isEmpty){
    println(s"Can't find ${funcName} in ${filePath}")
    return Nil          
  }
  val funcNode = target.get
  def callersOf(m: Method): List[Method] = {
    graph.call.nameExact(m.name).method.l.distinct
  }
  def helper(m: Method, depth:Int): List[List[String]] = {
    val selfInfo = s"${m.name} (${m.filename}:${m.lineNumber.getOrElse(-1)})"
    if(depth >= 5)
      List(List(selfInfo))
    else{
      val callers = callersOf(m)
      if(callers.isEmpty)
        List(List(selfInfo))
      else
        callers.flatMap(c => helper(c, depth + 1).map(path => selfInfo +: path))                                                    
    }                    
  }
  helper(funcNode, 0).map(_.reverse.mkString(" -> ")).distinct
}

/**
 *  @return 
 */
def getDirectCallSites(projectName: String, funcName: String, filePath: String): List[String] = {
  val graph = cpg
  val target = graph.method.nameExact(funcName).filename(filePath).headOption
  if (target.isEmpty){
    println(s"Can't find ${funcName} in ${filePath}")
    return Nil
  }
  val funcNode = target.get
  val calls = graph.call.where(_.methodFullNameExact(funcNode.fullName)).l
  def findFile(node: AstNode): String = {
    node match{
      case f: File => f.name
      case other =>
        val parentOpt = other._astIn.nextOption
        if (parentOpt.isEmpty) "<unknown>"
        else findFile(parentOpt.get.asInstanceOf[AstNode])
    }
  }
  val results = calls.flatMap { c=>
    val codeStr = c.code
    val lineLoc = c.lineNumber.getOrElse(-1)
    val fileLoc = findFile(c)
    List(s"code: ${codeStr}", s"loc:  ${fileLoc}:${lineLoc}")
  }.distinct
  results
}

/**
 * @return 
 */
def getAllComments(projectName: String) = {
  cpg
    .comment
    .toSet
}

def getAllCommentsJson(projectName: String) = {
  cpg
    .comment
    .toJsonPretty
}

def getAllGlobalVarsByName(projectName: String) = {
  cpg
    .local
    .filter(isGlobalVar)
    .sortBy(_.lineNumber)
    .toList
}

def getAllGlobalVarsJson(projectName: String) = {
  getAllGlobalVarsByName(projectName)
    .toJsonPretty
}

/**
 * 
 */
def getNodeLineRange[T <: AstNode](node: T) = {
  val cstartLine = node.lineNumber.getOrElse(-1)
  val cTotalLine = node.code.linesIterator.size
  val cEndLine = cstartLine + cTotalLine - 1
  cstartLine to cEndLine
}

/**
 * AST
 */
def astNode2Comment[T <: AstNode](projectName: String, node: T, file: String) = {
  val allComment = getAllComments(projectName)
  allComment.filter { c =>
    val commentLineRange = getNodeLineRange(c)
    val validRange = commentLineRange.start to commentLineRange.end+1
    val gLine = node.lineNumber.getOrElse(-1)
    c.filename == file && validRange.contains(gLine)
  }
}

def astNode2CommentJson[T <: AstNode](projectName: String, node: T, file: String) = {
  astNode2Comment(projectName, node, file)
    .toJsonPretty
}

def isUserMethod(m: Method): Boolean = {
  // code != <empty> => ()
  m.filterNot(_.isExternal)
   .filterNot(_.name.endsWith(">"))
   .filterNot(m => m.code == "<empty>" || (m.code.startsWith("extern ") && m.code.endsWith(";")))
   .headOption
   .nonEmpty
}

def getCallGraph(cpg: Cpg) = {
  cpg
    .method
    .filter(isUserMethod)
    // isGeneral =>
    .map(m => (m.name, m.call.filter(!_.isInline).callee.filter(isUserMethod).name.toSet))
    .l
}

/**
 * Find the shortest call chain from entryFunc to targetFunc via DFS on the
 * forward call graph. Returns the chain as a List of function names
 * (inclusive, e.g. List("main", "CPUInitial", "LvtInitial")), or an empty
 * List if targetFunc is not reachable from entryFunc.
 * Uses a visited set and depth limit to guard against cycles.
 */
def findCallChain(
  forwardCg: Map[String, Set[String]],
  entryFunc: String,
  targetFunc: String,
  maxDepth: Int = 10
): List[String] = {
  if (entryFunc == targetFunc) return List(entryFunc)

  // BFS to find shortest chain
  val queue = mutable.Queue[List[String]]()
  val visited = mutable.Set[String](entryFunc)
  queue.enqueue(List(entryFunc))

  while (queue.nonEmpty) {
    val path = queue.dequeue()
    if (path.length > maxDepth) return List.empty

    val current = path.last
    for (callee <- forwardCg.getOrElse(current, Set.empty)) {
      if (callee == targetFunc) return path :+ callee
      if (!visited.contains(callee)) {
        visited += callee
        queue.enqueue(path :+ callee)
      }
    }
  }

  List.empty // Not reachable
}

/**
 * Collect caller-side conditions, assignments, and enclosing conditions along
 * the call chain from entryFunc to targetFunc.
 *
 * For each hop (caller → callee) in the chain:
 *   1. Find call sites in the caller that invoke the callee
 *   2. Run cfgReachability(callerMethod, -1, callSiteLine) to get path
 *      conditions and assignments from the caller's entry to the call site
 *   3. Run getEnclosingConditions on the call-site node to capture structural
 *      nesting (if/while bodies around the call)
 *
 * Uses the first call site per hop (by line number). The has_multiple_call_sites
 * flag indicates when more than one call site exists for any hop.
 */
def getCallerConditions(
  forwardCg: Map[String, Set[String]],
  entryFunc: String,
  targetFunc: String,
  interruptApis: Set[String],
  globalVars: Set[String] = Set.empty
): Obj = {
  val allConditions = Arr()
  val allAssignments = Arr()
  val allEnclosingConditions = Arr()
  var hasMultipleCallSites = false

  val chain = findCallChain(forwardCg, entryFunc, targetFunc)
  if (chain.length < 2) {
    // Same function or not reachable — nothing to collect
    return Obj(
      "caller_conditions" -> Arr(),
      "caller_assignments" -> Arr(),
      "caller_enclosing_conditions" -> Arr(),
      "call_chain" -> Arr(chain.map(ujson.Str(_)): _*),
      "has_multiple_call_sites" -> false
    )
  }

  // Walk each hop: chain(0)→chain(1), chain(1)→chain(2), …
  for (hopIdx <- 0 until chain.length - 1) {
    val callerName = chain(hopIdx)
    val calleeName = chain(hopIdx + 1)

    val callerMethods = cpg.method.nameExact(callerName).toList
    if (callerMethods.nonEmpty) {
      val callerMethod = callerMethods.head

      // Find call sites in callerMethod that call calleeName
      val callSites = Try {
        callerMethod.call
          .filter(c => {
            val calleeNames = Try(c.callee.filter(isUserMethod).name.toList).getOrElse(List.empty)
            calleeNames.contains(calleeName)
          })
          .l
          .sortBy(c => c.lineNumber.getOrElse(0))
      }.getOrElse(List.empty)

      if (callSites.size > 1) {
        hasMultipleCallSites = true
      }

      if (callSites.nonEmpty) {
        val callSite = callSites.head
        val callSiteLine = callSite.lineNumber.getOrElse(0)

        if (callSiteLine > 0) {
          // 1. CFG reachability from caller entry to the call site
          val cfgResult = cfgReachability(callerMethod, -1, callSiteLine, interruptApis)
          scopeResultLocals(cfgResult, callerName, globalVars)

          if (cfgResult("reachable").bool) {
            // Collect path conditions
            for (c <- cfgResult.obj.getOrElse("conditions", Arr()).arr) {
              allConditions.arr += Obj(
                "expression" -> c("expression"),
                "branch" -> c("branch"),
                "line" -> c("line"),
                "caller" -> ujson.Str(callerName),
                "hop" -> ujson.Num(hopIdx.toDouble)
              )
            }
            // Collect path assignments
            for (a <- cfgResult.obj.getOrElse("assignments", Arr()).arr) {
              allAssignments.arr += Obj(
                "variable" -> a("variable"),
                "value" -> a("value"),
                "line" -> a("line"),
                "is_constant" -> a("is_constant"),
                "caller" -> ujson.Str(callerName),
                "hop" -> ujson.Num(hopIdx.toDouble)
              )
            }
          }

          // 2. Enclosing conditions of the call-site node itself
          val enclosingRaw = getEnclosingConditions(callSite, callerMethod)
          val enclosing = scopeConditionTuples(enclosingRaw, callerName, globalVars)
          for ((expr, branch, line) <- enclosing) {
            allEnclosingConditions.arr += Obj(
              "expression" -> ujson.Str(expr),
              "branch" -> ujson.Str(branch),
              "line" -> ujson.Num(line.toDouble),
              "caller" -> ujson.Str(callerName),
              "hop" -> ujson.Num(hopIdx.toDouble)
            )
          }
        }
      }
    }
  }

  Obj(
    "caller_conditions" -> allConditions,
    "caller_assignments" -> allAssignments,
    "caller_enclosing_conditions" -> allEnclosingConditions,
    "call_chain" -> Arr(chain.map(ujson.Str(_)): _*),
    "has_multiple_call_sites" -> ujson.Bool(hasMultipleCallSites)
  )
}

def getTopLevelCallers(projectName: String, calleeName: String): List[String] = {
  val reverseGraph = mutable.Map.empty[String, mutable.Set[String]]
  val graph = cpg

  getCallGraph(graph).foreach { case (caller, callees) =>
    callees.foreach { callee =>
      val callers = reverseGraph.getOrElseUpdate(callee, mutable.Set.empty[String])
      callers += caller
    }
  }

  val visited = mutable.Set.empty[String]
  val stack = mutable.Stack[String](calleeName)

  while (stack.nonEmpty) {
    val current = stack.pop()
    if (visited.add(current)) {
      reverseGraph.get(current).foreach { parents =>
        parents.foreach(stack.push)
      }
    }
  }

  visited.collect {
    case method if method != calleeName && reverseGraph.getOrElse(method, mutable.Set.empty[String]).isEmpty =>
      method
  }.toList.sorted
}

def getCallGraphJson(projectName: String) = {
  getCallGraph(cpg)
    .toJsonPretty
}

def getFunction(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
}

def getFunctionJson(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
    .toJsonPretty
}

def getFunctionBody(projectName: String, functionName: String) = {
  getFunction(projectName, functionName)
    .code
}

def getFunctionBodyJson(projectName: String, functionName: String) = {
  getFunctionBody(projectName, functionName)
    .toJsonPretty
}

/**
 * 
 * @param projectName
 * @param functionName
 */
def getFunctionComment(projectName: String, functionName: String) = {
  val fun = cpg.method(functionName).head
  astNode2Comment(projectName, fun, fun.filename)
}

def getFunctionCommentJson(projectName: String, functionName: String) = {
  getFunctionComment(projectName, functionName)
    .toJsonPretty
}

def getFunctionParameterIn(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
    .parameter
}

def getFunctionParameterInJson(projectName: String, functionName: String) = {
  getFunctionParameterIn(projectName, functionName)
    .toJsonPretty
}

def getFunctionRet(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
    .methodReturn
}

def getFunctionRetJson(projectName: String, functionName: String) = {
  getFunctionRet(projectName, functionName)
    .toJsonPretty
}

def getFunctionAllId(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
    .ast
    .isIdentifier
    .name
}

def getFunctionGlobal(projectName: String, functionName: String) = {
  val allGlobalVars = getAllGlobalVarsByName(projectName)
  val allIdNameInFun = getFunctionAllId(projectName, functionName).toSet
  allGlobalVars.filter(g => allIdNameInFun.contains(g.name))
}

def getFunctionGlobalJson(projectName: String, functionName: String) = {
  getFunctionGlobal(projectName, functionName)
    .toJsonPretty
}

def getGlobalVarByName(projectName: String, globalName: String) = {
  cpg
    .local
    .filter(isGlobalVar)
    .name(globalName)
}

def getGlobalVarFileName(projectName: String, globalName: String) = {
  getGlobalVarByName(projectName, globalName).file.name.headOption.toJsonPretty
}

def getAllGlobalVar2FileName(projectName: String) = {
  val globalVars = cpg.local.filter(isGlobalVar)

  val resultMap : Map[String, JsValue] = globalVars.foldLeft(Map.empty[String, JsValue]) {
    case (map, l) => {
      val fileName = l.file.headOption match {
        case Some(file) => file.name
        case _ => ""
      }
      map + (l.name -> JsString(fileName))
    }
  }
  JsObject(resultMap).prettyPrint
}

def getGlobalVarByNameJson(projectName: String, globalName: String) = {
  getGlobalVarByName(projectName, globalName)
    .toJsonPretty
}

def getFunctionCallSites(projectName: String, functionName: String) = {
  cpg
    .method(functionName)
    .call
    .filter(!_.isInline)   // : .filter(c => c.callee.exists(isUserMethod))
    .sortBy(_.lineNumber)
}

def getFunctionCallSitesJson(projectName: String, functionName: String) = {
  getFunctionCallSites(projectName, functionName)
    .toJsonPretty
}

/**
 * String -> Set[Call]
 * callerMethod -> CallSite Set
 */
def getFunctionCaller2Sites(projectName: String, functionName: String) = {
  cpg
    .method
    .flatMap(m => {
      val calls = m.call.filter(_.callee.name.contains(functionName)).sortBy(_.lineNumber)
      if (calls.nonEmpty) Some((m.name, calls.sortBy(_.lineNumber))) else None
    })
}

def getFunctionCaller2SitesJson(projectName: String, functionName: String) = {
  getFunctionCaller2Sites(projectName, functionName)
    .toJsonPretty
}

def getContent(filePath: String) = {
  val encodings = List("GBK", "UTF-8", "ISO-8859-1")
  val encoding = encodings.find { encoding =>
    Using(Source.fromFile(filePath, encoding)) { source =>
      source.mkString
    }.isSuccess
  }
  encoding match {
    case Some(code) => {
      Using(Source.fromFile(filePath, code)) { source =>
        source.mkString
      } match {
        case Success(content) => {
          //println(": " + code + "\n" + content)
          content
        }
        case Failure(exception) => {
          println(s": $filePath")
          ""
        }
      }
    }
    case _ => {
      println(s": $filePath")
      ""
    }
  }
}

def getContentLines(projectName: String, filePath: String): List[String] = {
  val key = projectName + "#" + filePath
  val contentsLines = filePath2Lines.computeIfAbsent(key, _ => {
    val content = getContent(filePath)
    content.linesIterator.toList
  })
  contentsLines
}

def getProjectRoot(projectName: String) = {
  val metaData = cpg.metaData.headOption
  metaData match {
    case Some(meta) => {
      List(meta.root).toJsonPretty
    }
    case _ => {
      println("None metaData")
      List("").toJsonPretty
    }
  }
}

def getAbsPath(cpg: Cpg, file: String): Option[String] = {
  val metaData = cpg.metaData.headOption
  metaData match {
    case Some(d) => {
      val rootPath = Paths.get(d.root)
      val fileAbsPath = rootPath.resolve(file).toAbsolutePath
      Some(fileAbsPath.toFile.getAbsolutePath)
    }
    case _ => {
      println("None metaData")
      None
    }
  }
}

def getAbsPathFromFile(cpg: Cpg, file: File): Option[String] = {
  getAbsPath(cpg, file.name)
}

def getAbsPathByName(projectName: String, file: File): Option[String] = {
  getAbsPathFromFile(cpg, file)
}

def getContextLines[T <: AstNode](projectName: String, file: File, node: T) = {
  val absPathOpt = getAbsPathByName(projectName, file)
  absPathOpt match {
    case Some(absPath) => {

      val codeTotalLine = node.code.linesIterator.size
      val codeLineRange = node.lineNumber.getOrElse(-1) to (node.lineNumber.getOrElse(-1)+codeTotalLine-1)

      // 1-10; 2-11
      val startOffset = (codeLineRange.start-1) - 1
      val endOffset = (codeLineRange.end-1) + 1
      // +1: [x, y)

      //  1 ~ 1
      val lines = getContentLines(projectName, absPath)
      lines.slice(startOffset, endOffset + 1).mkString("\n")
    }
    case _ => {
      println("None metaData")
      ""
    }
  }
}

def getContextByLine(projectName: String, file: String, line: String, offset: String) = {
  val lineInt: Int = line.toInt
  val offsetInt: Int = offset.toInt

  getContentLines(projectName, file) match {
    case lines if lines.nonEmpty =>
      val totalLines = lines.size
      val start = math.max(lineInt - offsetInt, 0)
      val end = math.min(lineInt + offsetInt + 1, totalLines) // +1slice

      lines.slice(start, end).mkString("\n")
    case _ =>
      println("lines is empty")
      ""
  }
}

/**
 *  (, )
 */
def getCallSiteCommentContext(projectName: String, callsite: Call): Map[String, Any] = {
  callsite.file.headOption match {
    case Some(file) => {
      val nodeFile = callsite.file.head
      /// 1. 
      val contextLines = getContextLines(projectName, nodeFile, callsite)
      /// 2. 
      val comments = astNode2Comment(projectName, callsite, nodeFile.name).headOption
      Map("context" -> contextLines, "comment" -> comments)
    }
    case _ => Map("context" -> "", "comment" -> None)
  }
}

def getCallSiteCommentContextById(projectName: String, callSiteId: Long): Map[String, Any] = {
  val call = cpg.call.id(callSiteId).head
  getCallSiteCommentContext(projectName, call)
}

def getCallSiteCommentContextJson(projectName: String, callsiteId: Long) = {
  getCallSiteCommentContextById(projectName, callsiteId)
    .toJsonPretty
}

def getFunctionFileName(projectName: String, funName: String) = {
  cpg.method(funName).filename.headOption.toJsonPretty
}

def getAllFiles(projectName: String) = {
  cpg.file.filterNot(_.name.endsWith(">")).toJsonPretty
}

def getFunctionInFile(projectName: String, fileName: String) = {
  cpg
    .method
    .filter(isUserMethod)
    .filenameExact(fileName)
    .sortBy(m => m.lineNumber.getOrElse(0))
    .toJsonPretty
}

case class _Invocation(id: String, line: Int, path: String, sourceId: String, targetId: String)

object InvocationJsonFormat extends JsonWriter[_Invocation] {
  override def write(obj: _Invocation): JsValue = {
    JsObject(
      "id" -> JsString(obj.id),
      "line" -> JsNumber(obj.line),
      "path" -> JsString(obj.path),
      "sourceId" -> JsString(obj.sourceId),
      "targetId" -> JsString(obj.targetId)
    )
  }
}

case class _Method(id: String, name: String, line: Int, path: String)

object MethodJsonFormat extends JsonWriter[_Method] {
  override def write(obj: _Method): JsValue = {
    JsObject(
      "id" -> JsString(obj.id),
      "line" -> JsNumber(obj.line),
      "name" -> JsString(obj.name),
      "path" -> JsString(obj.path)
    )
  }
}

def getCallLevelRelation(projectName: String, funName: String, callLevel: String) = {
  val maxLevel = callLevel.toInt
  val coreMethod = cpg.method(funName).head

  val callsResult = mutable.Set[Call]()

  val visited = mutable.Set[Method]()
  val queue = mutable.Queue[Method]()

  queue.enqueue(coreMethod)
  visited += coreMethod

  var curLevel = 0

  while (queue.nonEmpty && curLevel <= maxLevel) {
    val layerSize = queue.size
    for (i <- 0 until layerSize) {
      val method = queue.dequeue()
      // 
      method.call.filter(!_.isInline).foreach(callsite => {
        var hasProcess = false
        callsite.callee.foreach(callee => {
          if (!visited.contains(callee) && curLevel < maxLevel) {
            queue.enqueue(callee)
            visited += callee
            hasProcess = true
          }
        })
        if (hasProcess) {
          callsResult += callsite
        }
      })

      // 
      method.callIn.filter(!_.isInline).foreach(callsite => {
        val callerMethod = callsite.method
        if (curLevel < maxLevel)
        {
          if (!visited.contains(callerMethod))
          {
            queue.enqueue(callerMethod)
            visited += callerMethod
          }
          callsResult += callsite
        }
      })
    }
    curLevel += 1
  }

  // now, find all related methods / callsites
  val invocations = callsResult.flatMap(call => {
    val id = call.id().toString
    val line = call.lineNumber.getOrElse(0)
    val path = getAbsPathByName(projectName, call.file.head) match {
      case Some(absPath) => absPath
      case _ => ""
    }
    val sourceId = call.method.id().toString
    call.callee.map(ee => {
      val targetId = ee.id().toString
      _Invocation(id, line, path, sourceId, targetId)
    })
  })

  val methods = visited.map(method => {
    val id = method.id().toString
    val name = method.name
    val line = method.lineNumber.getOrElse(0)
    val path = getAbsPathByName(projectName, method.file.head) match {
      case Some(absPath) => absPath
      case _ => ""
    }
    _Method(id, name, line, path)
  })
  
  val invocationsJson = invocations.map(InvocationJsonFormat.write).toList
  val methodsJson = methods.map(MethodJsonFormat.write).toList

  val jsonObject = JsObject(
    "invocations" -> JsArray(invocationsJson.toVector),
    "methods" -> JsArray(methodsJson.toVector)
  )
  jsonObject.prettyPrint
}

/**
 * see MacroHandler#fullName, like:
 * 1. test.c:5:8:PRINT_VARIABLE_INFO:1
 * 2. test.c:3:3:X:0
 * @param projectName
 * @param funName
 * @return
 */
def getFunMacrosJson(projectName: String, funName: String) = {
  val _cpg = cpg

  val mtd = _cpg.method(funName).head
  val mtdFile = mtd.filename
  val methodLineStart = mtd.lineNumber.getOrElse(-1)
  val methodLineEnd = mtd.lineNumberEnd.getOrElse(-1)

  val macroFullName = _cpg
    .call
    .filter(c => {
      c.isInline && (c.file.headOption match {
        case Some(callFile) => {
          val callLine = c.lineNumber.getOrElse(-2)
          callFile.name == mtdFile &&
          // 
          (callLine >= methodLineStart && callLine <= methodLineEnd)
        }
        case _ => false
      })
    })
    .map(c => c.methodFullName)
    .toSet

  val components = macroFullName.map(fullName => {
    val s = fullName.split(":")
    val shortFileName = s(0)
    val startLine = s(1).toInt
    val endLine = s(2).toInt
    val macroName = s(3)
    val absPathOpt = getAbsPath(_cpg, shortFileName)
    val content = absPathOpt match {
      case Some(absPath) => {
        val lines = getContentLines(projectName, absPath)
        lines.slice(startLine-1, endLine).mkString("\n")
      }
      case _ => ""
    }
    macroName -> JsString(content)
  }).l
  JsObject(components.toSeq: _*).prettyPrint
}

def getAllMacrosJson(projectName: String) = {
  val macroFullName = cpg
    .call
    .filter(_.isInline)
    .map(_.methodFullName)
    .toSet

  val components = macroFullName.map(fullName => {
    val s = fullName.split(":")
    val shortFileName = s(0)
    val startLine = s(1).toInt
    val endLine = s(2).toInt
    val macroName = s(3)
    macroName -> JsObject(
      "filename" -> JsString(shortFileName),
      "startLine" -> JsNumber(startLine),
      "endLine" -> JsNumber(endLine)
    )
  }).l
  JsObject(components.toSeq: _*).prettyPrint
}

def getFileContentLines(projectName: String, relFilePath: String) = {
  val _cpg = cpg
  val absPathOpt = getAbsPath(_cpg, relFilePath)
  val lines = absPathOpt match {
    case Some(absPath) => getContentLines(projectName, absPath)
    case _ => List.empty
  }
  lines.toJsonPretty
}

def getSliceNodeJsonObject(sliceNode: SliceNode) = {
  JsObject(
    "id" -> JsNumber(sliceNode.id),
    "label" -> JsString(sliceNode.label),
    "name" -> JsString(sliceNode.name),
    "code" -> JsString(sliceNode.code),
    "typeFullName" -> JsString(sliceNode.typeFullName),
    "parentMethod" -> JsString(sliceNode.parentMethod),
    "parentFile" -> JsString(sliceNode.parentFile),
    "lineNumber" -> JsNumber(sliceNode.lineNumber.getOrElse(-1)),
    "columnNumber" -> JsNumber(sliceNode.columnNumber.getOrElse(-1))
  )
}

def getSliceEdgeJsonObject(sliceEdge: SliceEdge) = {
  JsObject(
    "src" -> JsNumber(sliceEdge.src),
    "dst" -> JsNumber(sliceEdge.dst),
    "label" -> JsString(sliceEdge.label)
  )
}

// Define a case class for slice result to ensure proper type inference
case class SliceResult(nodes: List[SliceNode], edges: List[SliceEdge])

def ddSlice(cpg: Cpg, cfgNodes: List[CfgNode]): SliceResult = {
  // According to DataFlowSlicing.scala source:
  // calculateDataFlowSlice(cpg: Cpg, config: DataFlowConfig): Option[DataFlowSlice]
  // DataFlowSlice has nodes: Set[SliceNode] and edges: Set[SliceEdge]
  // 
  // Note: This method calculates slice for the entire CPG based on config filters,
  // not from specific cfgNodes. The cfgNodes parameter is kept for API compatibility
  // but not used. To slice from specific nodes, you'd need to configure DataFlowConfig
  // with appropriate filters.
  val sliceOption = DataFlowSlicing.calculateDataFlowSlice(cpg, DataFlowConfig())
  
  // Handle Option return type and extract nodes/edges
  // DataFlowSlice.nodes and .edges are Sets, convert to Lists for compatibility
  sliceOption match {
    case Some(slice) => 
      // DataFlowSlice has nodes: Set[SliceNode] and edges: Set[SliceEdge]
      SliceResult(slice.nodes.toList, slice.edges.toList)
    case None =>
      // Return empty slice if calculation fails
      SliceResult(List.empty[SliceNode], List.empty[SliceEdge])
  }
}

def ddSliceFromLineId(projectName: String, fileName: String, lineNumber: String, varName: String) = {
  val _cpg = cpg
  val line = lineNumber.toInt
  val ids = _cpg.file(fileName).ast.isIdentifier.name(varName).lineNumber(line).toList
  val slice = ddSlice(_cpg, ids)

  JsObject(
    "startNodes" -> JsArray(ids.map(id => JsNumber(id.id())).toVector),
    "nodes" -> JsArray(slice.nodes.toList.map(getSliceNodeJsonObject).toVector),
    "edges" -> JsArray(slice.edges.toList.map(getSliceEdgeJsonObject).toVector)
  )
  .prettyPrint
}

// ── queryVariableAccesses ──
// For a given set of variable names and entry functions, find ALL access sites
// (READ / WRITE) across the full call-reachable function set of each entry.
// This is used by multivar_violation_detect to build cross-context access
// sequences independently of the correlated-variable identification step.

def queryVariableAccesses(projectName: String, varNames: List[String], entryFunctions: List[String]): String = {
  val cg = getCallGraph(cpg).toMap
  val allGlobalVars = getAllGlobalVars(cpg).toSet
  val varSet = varNames.toSet

  // Build array base patterns: for variables with constant indices like
  // "mRoughVector.v3[0]", extract "mRoughVector.v3" as a base pattern.
  // This allows matching ISR accesses like "mRoughVector.v3[i]" (variable index)
  // which Joern represents as a different code expression but semantically
  // accesses the same array.
  //
  // IMPORTANT: Only strip the TRAILING bracket suffix — not inner brackets.
  // This correctly handles multi-dimensional arrays:
  //   "matrix[0][1]" → strips trailing "[1]" → "matrix[0]"
  //   "arr[0]"       → strips trailing "[0]" → "arr"
  val trailingConstIndex = """\[\d+\]$""".r   // trailing constant index only
  val trailingAnyIndex   = """\[[^\]]*\]$""".r // trailing any index only
  val arrayBaseSet: Set[String] = varSet
    .filter(v => trailingConstIndex.findFirstIn(v).isDefined)
    .map(v => trailingConstIndex.replaceFirstIn(v, ""))

  // Expand each entry function into its full set of reachable callees
  val entry2Funcs = entryFunctions.map(e => (e, getRelatedFuncs(cg, e))).toMap

  val accesses = Arr()

  for ((entryName, reachableFuncs) <- entry2Funcs) {
    for (funcName <- reachableFuncs) {
      val methods = cpg.method.nameExact(funcName).toList
      for (method <- methods) {
        // 1. Plain Identifier references (simple global vars like flag_data)
        val ids = method.ast.isIdentifier
          .filter(id => varSet.contains(id.name) && allGlobalVars.contains(id.name))
          .toList

        for (id <- ids) {
          // Skip identifiers inside indirection calls (handled in Section 3)
          val isInsideIndirection = id._astIn.nextOption match {
            case Some(parentCall: Call) => parentCall.name == Operators.indirection
            case _ => false
          }
          if (!isInsideIndirection) {
            val accessType = determineAccessType(id)

            val filePath = id.file.name.headOption.getOrElse("")
            accesses.arr += Obj(
              "variable"       -> ujson.Str(id.name),
              "entry_function" -> ujson.Str(entryName),
              "function"       -> ujson.Str(funcName),
              "access_type"    -> ujson.Str(accessType),
              "file_path"      -> ujson.Str(filePath),
              "line"           -> ujson.Num(id.lineNumber.getOrElse(-1).toDouble),
              "column"         -> ujson.Num(id.columnNumber.getOrElse(-1).toDouble),
              "code"           -> ujson.Str(id.code)
            )
          }
        }

        // 2. Field / index access expressions (struct.field, arr[i])
        //    Match calls that are fieldAccess, indirectFieldAccess, or indexAccess
        //    whose base identifier is in the target variable set.
        val fieldCalls = method.ast.isCall
          .filter(c =>
            c.name == Operators.fieldAccess ||
            c.name == Operators.indirectFieldAccess ||
            c.name == Operators.indexAccess ||
            c.name == Operators.indirectIndexAccess
          )
          .toList

        // Track emitted (line, entryName, arrayBase) tuples to avoid duplicates
        // when both the inner fieldAccess (mRoughVector.v3) and outer indexAccess
        // (mRoughVector.v3[i]) match for the same source location and base.
        // Prefer the outermost (most specific) match — indexAccess over fieldAccess.
        // Uses the array base (stripping any [..] suffix) so that different variables
        // on the same line (e.g., Time.MS and Time.deltaMS on L605) are NOT deduped.
        val emittedFieldLines = mutable.Set[(Int, String, String)]()

        // Process indexAccess calls FIRST (outermost, most specific expression),
        // then fieldAccess calls (inner, less specific).
        val (indexCalls, nonIndexCalls) = fieldCalls.partition(c =>
          c.name == Operators.indexAccess || c.name == Operators.indirectIndexAccess
        )
        val orderedFieldCalls = indexCalls ++ nonIndexCalls

        for (call <- orderedFieldCalls) {
          val apElems = getAPElements(call)
          if (!apElems.isEmpty) {
            val baseName = apElems.elements(0).toString
            // Check if the full expression code (e.g. "upload_data[0]") or the
            // base name (e.g. "upload_data") is in the requested variable set.
            val exprCode = call.code
            val normalizedCode = exprCode.replaceAll("\\s+", "")
            // Direct match: exact variable name, normalized, or base name
            val directMatch = varSet.contains(normalizedCode) || varSet.contains(exprCode) || varSet.contains(baseName)
            // Array base match: for accesses like "arr[i]" (variable index), check if
            // stripping the trailing [...] yields a base that matches our arrayBaseSet.
            // Only strips the LAST bracket suffix to handle multi-dimensional arrays
            // correctly (e.g., matrix[0][i] → matrix[0], not matrix).
            val arrayBaseMatch = if (!directMatch && arrayBaseSet.nonEmpty) {
              val codeBase = trailingAnyIndex.replaceFirstIn(normalizedCode, "")
              arrayBaseSet.contains(codeBase)
            } else false

            if (directMatch || arrayBaseMatch) {
              val lineNum = call.lineNumber.getOrElse(-1)
              // Compute array base for dedup: strip trailing [...] suffix
              val dedupBase = trailingAnyIndex.replaceFirstIn(normalizedCode, "")
              val lineKey = (lineNum, entryName, dedupBase)
              // Skip inner fieldAccess if we already emitted the outer indexAccess
              // for the same line and same base — the outer access has the correct
              // access type (WRITE for LHS of assignment) and is more specific.
              // Different variables (different dedupBase) on the same line are NOT deduped.
              if (!emittedFieldLines.contains(lineKey)) {
                emittedFieldLines += lineKey
                val accessType = determineAccessType(call)

                val filePath = call.file.name.headOption.getOrElse("")
                accesses.arr += Obj(
                  "variable"       -> ujson.Str(exprCode),
                  "entry_function" -> ujson.Str(entryName),
                  "function"       -> ujson.Str(funcName),
                  "access_type"    -> ujson.Str(accessType),
                  "file_path"      -> ujson.Str(filePath),
                  "line"           -> ujson.Num(lineNum.toDouble),
                  "column"         -> ujson.Num(call.columnNumber.getOrElse(-1).toDouble),
                  "code"           -> ujson.Str(exprCode)
                )
              }
            }
          }
        }

        // 3. Pointer dereference expressions (*ptr)
        //    Match calls that are Operators.indirection whose base identifier
        //    is in the target variable set.
        val indirectionCalls = method.ast.isCall
          .filter(c => c.name == Operators.indirection)
          .toList

        for (call <- indirectionCalls) {
          val apElems = getAPElements(call)
          if (!apElems.isEmpty) {
            val baseName = apElems.elements(0).toString
            if (varSet.contains(baseName)) {
              val accessType = determineAccessType(call)
              val filePath = call.file.name.headOption.getOrElse("")
              accesses.arr += Obj(
                "variable"       -> ujson.Str(baseName),
                "entry_function" -> ujson.Str(entryName),
                "function"       -> ujson.Str(funcName),
                "access_type"    -> ujson.Str(accessType),
                "file_path"      -> ujson.Str(filePath),
                "line"           -> ujson.Num(call.lineNumber.getOrElse(-1).toDouble),
                "column"         -> ujson.Num(call.columnNumber.getOrElse(-1).toDouble),
                "code"           -> ujson.Str(call.code)
              )
            }
          }
        }
      }
    }
  }

  val result = Obj("accesses" -> accesses)
  ujson.write(result, indent = 2)
}

// ── analyzePathFeasibility ──
// For each atomicity violation candidate, decompose the 4-access interleaving
// into 3 sub-paths and verify CFG reachability, collect branch conditions,
// assignments, enclosing conditions, and interrupt enable/disable API calls.

/**
 * Get the enclosing conditions for a given AST node within a method.
 *
 * Walks up the AST ancestor chain from `node` to `method`, collecting
 * the branch conditions (if/while/for) that must be satisfied for the
 * node to execute.  For each ControlStructure ancestor, determines whether
 * the node is in the true-body or the false-body (else).
 *
 * @param node   The AST node whose enclosing context we want
 * @param method The enclosing method (stop point for the walk)
 * @return List of (conditionExpression, branch, conditionLine)
 */
def getEnclosingConditions(
  node: StoredNode,
  method: Method
): List[(String, String, Int)] = {
  val results = mutable.ListBuffer[(String, String, Int)]()
  var current: StoredNode = node

  var depth = 0
  val maxDepth = 50 // Safety limit for AST walk

  while (depth < maxDepth) {
    depth += 1
    val parentOpt = Try(current._astIn.nextOption).getOrElse(None)
    parentOpt match {
      case None => return results.toList
      case Some(parent) =>
        if (parent.id() == method.id()) return results.toList
        parent match {
          case cs: ControlStructure
            if cs.controlStructureType == "IF" ||
               cs.controlStructureType == "WHILE" ||
               cs.controlStructureType == "FOR" =>

            val condNodes = Try(cs.condition.toList).getOrElse(List.empty)
            if (condNodes.nonEmpty) {
              val condNode = condNodes.head
              val condLine = condNode.lineNumber.getOrElse(-1)
              val condExpr = condNode.code

              // Check if `node` is a descendant of the condition itself
              // (i.e., node IS part of the if-condition expression, not the body)
              val condDescendantIds = mutable.Set[Long]()
              Try(condNode.ast.foreach(n => condDescendantIds += n.id()))
              val nodeIsInCondition = condDescendantIds.contains(node.id())

              if (!nodeIsInCondition) {
                // Node is in the body — determine true or false branch
                val astChildren = Try(cs.astChildren.toList).getOrElse(List.empty)
                // AST children: [condition, trueBody, elseBody?]
                val trueBodyOpt = if (astChildren.size > 1) Some(astChildren(1)) else None
                val falseBodyOpt = if (astChildren.size > 2) Some(astChildren(2)) else None

                val trueBodyIds = mutable.Set[Long]()
                trueBodyOpt.foreach(tb => Try(tb.ast.foreach(n => trueBodyIds += n.id())))
                val falseBodyIds = mutable.Set[Long]()
                falseBodyOpt.foreach(fb => Try(fb.ast.foreach(n => falseBodyIds += n.id())))

                val inTrueBody = trueBodyIds.contains(node.id())
                val inFalseBody = falseBodyIds.contains(node.id())

                if (inTrueBody) {
                  results += ((condExpr, "true", condLine))
                } else if (inFalseBody) {
                  results += ((condExpr, "false", condLine))
                }
                // else: couldn't determine — skip (e.g., switch statements)
              }
              // If nodeIsInCondition, skip — the condition is being evaluated,
              // not yet decided
            }

          case _ => // skip non-control-structure ancestors
        }
        current = parent
    }
  }
  results.toList
}

/**
 * Extract short-circuit `&&` constraints from a compound condition expression.
 *
 * When multiple variables are read in a single `if (A > 0 && B < 10 && C == TRUE)`
 * condition, C's short-circuit `&&` evaluation only occurs if A > 0 and B < 10 are
 * already true.  This function uses the Joern AST to decompose the `&&` chain and
 * determine which sub-conditions are guaranteed true at the point where a specific
 * variable is read.
 *
 * Rather than regex on source text, we walk the AST structure of logicalAnd Call
 * nodes to extract the operands.
 *
 * @param method           The method containing the condition
 * @param conditionLine    The line number of the if-condition
 * @param targetVarName    The variable whose read we are analyzing
 * @param isSecondAccess   True if this is the second variable in the violation
 * @return List of (subConditionExpr, "true", condLine) for preceding sub-conditions
 */
def getShortCircuitConstraints(
  method: Method,
  conditionLine: Int,
  targetVarName: String,
  isSecondAccess: Boolean
): List[(String, String, Int)] = {
  if (!isSecondAccess) return List.empty

  // Find ControlStructure nodes at the condition line
  val controlStructures = Try(
    method.ast.isControlStructure
      .filter(cs => cs.controlStructureType == "IF" || cs.controlStructureType == "WHILE")
      .toList
  ).getOrElse(List.empty)

  val csAtLine = controlStructures.filter(cs =>
    Try(cs.condition.headOption.exists(_.lineNumber.getOrElse(-1) == conditionLine)).getOrElse(false)
  )

  if (csAtLine.isEmpty) return List.empty

  val cs = csAtLine.head
  val condNodeOpt = Try(cs.condition.headOption).getOrElse(None)
  if (condNodeOpt.isEmpty) return List.empty
  val condNode = condNodeOpt.get

  // Recursively collect the && chain operands in left-to-right order from the AST.
  // In Joern, `(A > 0) && (B < 10)` is represented as:
  //   Call("<operator>.logicalAnd")
  //     ├── Call("<operator>.greaterThan")  [A > 0]
  //     └── Call("<operator>.lessThan")      [B < 10]
  // For `A && B && C`, the AST is left-associative:
  //   logicalAnd(logicalAnd(A, B), C)
  def collectAndOperands(node: Expression): List[Expression] = {
    node match {
      case call: Call if call.name == "<operator>.logicalAnd" =>
        val args = Try(call.argument.toList).getOrElse(List.empty)
        if (args.size >= 2) {
          collectAndOperands(args(0)) ++ collectAndOperands(args(1))
        } else {
          List(node)
        }
      case _ => List(node)
    }
  }

  val condExpr = condNode match {
    case expr: Expression => expr
    case _ => return List.empty
  }

  val operands = collectAndOperands(condExpr)
  if (operands.size <= 1) return List.empty

  // Find which operand contains the target variable
  for (i <- operands.indices) {
    val opIdentifiers = Try(operands(i).ast.isIdentifier.name.toSet).getOrElse(Set.empty)
    if (opIdentifiers.contains(targetVarName)) {
      // Found the first operand referencing this variable
      val preceding = operands.take(i)
      return preceding.map(op => (op.code, "true", conditionLine))
    }
  }

  List.empty
}

/**
 * Perform CFG reachability analysis between two line numbers within a method.
 * Uses BFS to find a path from fromLine to toLine, collecting branch conditions,
 * assignments, and interrupt API calls along the way.
 *
 * @param method     The method to analyze
 * @param fromLine   Source line number (-1 = method entry)
 * @param toLine     Target line number
 * @param interruptApis Set of interrupt enable/disable API names to detect
 * @return JSON object with reachability result
 */
def cfgReachability(
  method: Method,
  fromLine: Int,
  toLine: Int,
  interruptApis: Set[String]
): Obj = {
  val cfg = CfgGenerator().generate(method)
  val succMap = mutable.Map[CfgNode, List[CfgNode]]()
  cfg.vertices.foreach(n => succMap(n.asInstanceOf[CfgNode]) = List.empty)
  cfg.edges.foreach(edge => {
    val src = edge.src.asInstanceOf[CfgNode]
    val dst = edge.dst.asInstanceOf[CfgNode]
    succMap(src) = dst :: succMap.getOrElse(src, List.empty)
  })

  val allNodes = cfg.vertices.map(_.asInstanceOf[CfgNode]).toList

  // Find the start node
  val startNode: Option[CfgNode] = if (fromLine == -1) {
    // Method entry: first successor of the method node itself
    allNodes.find(n => n.isInstanceOf[Method]) match {
      case Some(m) => succMap.getOrElse(m, List.empty).headOption
      case None => None
    }
  } else {
    // Find CFG node at or closest after fromLine
    allNodes
      .filter(n => n.lineNumber.getOrElse(-1) == fromLine && !n.isInstanceOf[Method])
      .sortBy(_.columnNumber.getOrElse(0))
      .headOption
      .orElse {
        allNodes
          .filter(n => n.lineNumber.getOrElse(-1) >= fromLine && !n.isInstanceOf[Method])
          .sortBy(_.lineNumber.getOrElse(Int.MaxValue))
          .headOption
      }
  }

  // Find the target node
  val targetNodes = allNodes
    .filter(n => n.lineNumber.getOrElse(-1) == toLine && !n.isInstanceOf[Method])

  if (startNode.isEmpty || targetNodes.isEmpty) {
    return Obj(
      "reachable" -> false,
      "conditions" -> Arr(),
      "interrupt_state_changes" -> Arr(),
      "path_length" -> 0,
      "via_calls" -> Arr(),
      "reason" -> ujson.Str(
        if (startNode.isEmpty) s"start node not found for line $fromLine"
        else s"target node not found for line $toLine"
      )
    )
  }

  val targetLineSet = targetNodes.map(_.id()).toSet

  // Pre-compute: build a map from branch-point CFG node → (condition_code, true_successors, false_successors)
  // In Joern's CFG, a ControlStructure condition node has 2+ successors:
  //   - the first ast child after condition is the "true" body
  //   - the "false" path bypasses the body (or goes to else)
  // We identify branch points as CFG nodes with >1 successor.
  val branchInfo = mutable.Map[Long, (String, Set[Long], Int)]()
  // branchInfo: nodeId -> (conditionExpression, trueBodyNodeIds, conditionLine)

  // Collect all control structures and their conditions
  val controlStructures = Try(method.ast.isControlStructure.toList).getOrElse(List.empty)
  for (cs <- controlStructures) {
    val condNodes = Try(cs.condition.toList).getOrElse(List.empty)
    for (condNode <- condNodes) {
      val condCfgNode = condNode.asInstanceOf[CfgNode]
      val succs = succMap.getOrElse(condCfgNode, List.empty)
      if (succs.size >= 2) {
        // Identify "true body" nodes: ast children of the ControlStructure after the condition
        // In Joern, the ControlStructure's AST children are: [condition, trueBody, elseBody?]
        val astChildren = Try(cs.astChildren.toList).getOrElse(List.empty)
        val trueBodyNodes = mutable.Set[Long]()
        // The "true" branch body is typically the second AST child (index 1)
        if (astChildren.size > 1) {
          val trueBody = astChildren(1)
          // Collect all CFG node IDs under the true body subtree
          Try {
            trueBody.ast.foreach(n => trueBodyNodes += n.id())
          }
        }
        branchInfo(condCfgNode.id()) = (condNode.code, trueBodyNodes.toSet, condNode.lineNumber.getOrElse(-1))
      }
    }
  }

  // BFS from startNode to any targetNode, max 2000 visited nodes
  // Uses parent-pointer map instead of full path storage: O(n) memory vs O(n×depth)
  val bfsQueue = mutable.Queue[CfgNode]()
  val bfsVisited = mutable.Set[Long]()
  val parentMap = mutable.Map[Long, CfgNode]()  // nodeId -> parentNode
  bfsQueue.enqueue(startNode.get)
  bfsVisited += startNode.get.id()

  var foundTarget: Option[CfgNode] = None
  var iterations = 0
  val maxIterations = 2000

  while (bfsQueue.nonEmpty && foundTarget.isEmpty && iterations < maxIterations) {
    iterations += 1
    val current = bfsQueue.dequeue()

    if (targetLineSet.contains(current.id())) {
      foundTarget = Some(current)
    } else {
      for (succ <- succMap.getOrElse(current, List.empty)) {
        if (!bfsVisited.contains(succ.id())) {
          bfsVisited += succ.id()
          parentMap(succ.id()) = current
          bfsQueue.enqueue(succ)
        }
      }
    }
  }

  // Reconstruct path from parentMap if target was found
  val foundPath: Option[List[CfgNode]] = foundTarget.map { target =>
    val path = mutable.ListBuffer[CfgNode](target)
    var cur = target
    while (parentMap.contains(cur.id())) {
      cur = parentMap(cur.id())
      path.prepend(cur)
    }
    path.toList
  }
  val hitSearchLimit = foundTarget.isEmpty && iterations >= maxIterations

  foundPath match {
    case None =>
      Obj(
        "reachable" -> false,
        "conditions" -> Arr(),
        "interrupt_state_changes" -> Arr(),
        "path_length" -> 0,
        "via_calls" -> Arr(),
        "hit_search_limit" -> ujson.Bool(hitSearchLimit),
        "reason" -> ujson.Str(
          if (hitSearchLimit) "search limit reached (>2000 nodes)" else "no CFG path found"
        )
      )
    case Some(path) =>
      val conditions = Arr()
      val assignments = Arr()
      val interruptChanges = Arr()
      val viaCalls = mutable.Set[String]()

      // Build a set of node IDs on this path for quick lookup
      val pathNodeIds = path.map(_.id()).toSet

      // Walk the path, for each consecutive pair (node, nextNode):
      // 1. Collect interrupt API calls
      // 2. Collect assignments (variable = value)
      // 3. Detect branch decisions
      for (i <- path.indices) {
        val node = path(i)

        // ── Interrupt API detection + Assignment collection ──
        node match {
          case call: Call =>
            val callName = call.name
            // Direct interrupt API call (e.g. __disable_irq())
            if (interruptApis.contains(callName)) {
              val effect = if (
                callName.toLowerCase.contains("disable") ||
                callName.toLowerCase.contains("enter") ||
                callName.toLowerCase.contains("cli")
              ) "disable" else "enable"
              interruptChanges.arr += Obj(
                "api" -> ujson.Str(callName),
                "line" -> ujson.Num(call.lineNumber.getOrElse(-1).toDouble),
                "effect" -> ujson.Str(effect)
              )
            }
            // Register assignment pattern: EA = 0 (8051)
            if (callName.startsWith("<operator>.assignment") || callName.startsWith("<operators>.assignment")) {
              Try {
                val left = call.argument(1)
                val right = call.argument(2)
                val leftCode = left.code.trim
                val rightCode = right.code.trim
                if (interruptApis.contains(leftCode)) {
                  val effect = if (rightCode == "0" || rightCode == "0x00") "disable" else "enable"
                  interruptChanges.arr += Obj(
                    "api" -> ujson.Str(s"$leftCode = $rightCode"),
                    "line" -> ujson.Num(call.lineNumber.getOrElse(-1).toDouble),
                    "effect" -> ujson.Str(effect)
                  )
                }
              }

              // ── NEW: Collect assignments for SMT constraint generation ──
              // Captures: variable = constant, variable = variable, variable = expression
              Try {
                val left = call.argument(1)
                val right = call.argument(2)
                // Only collect when the LHS is a simple identifier (not a complex expression)
                left match {
                  case id: Identifier =>
                    val varName = id.name
                    val valueCode = right.code.trim
                    val assignLine = call.lineNumber.getOrElse(-1)
                    // Determine if the RHS is a constant
                    val isConstant = right match {
                      case _: Literal => true
                      case rid: Identifier =>
                        // Check for common named constants
                        Set("TRUE", "true", "FALSE", "false", "NULL", "nullptr").contains(rid.name)
                      case _ => false
                    }
                    assignments.arr += Obj(
                      "variable" -> ujson.Str(varName),
                      "value" -> ujson.Str(valueCode),
                      "line" -> ujson.Num(assignLine.toDouble),
                      "is_constant" -> ujson.Bool(isConstant)
                    )
                  case fieldAccess: Call
                    if fieldAccess.name == Operators.fieldAccess ||
                       fieldAccess.name == Operators.indirectFieldAccess =>
                    // Struct field assignments like s.field = val or s->field = val
                    val varName = fieldAccess.code.trim
                    val valueCode = right.code.trim
                    val assignLine = call.lineNumber.getOrElse(-1)
                    val isConstant = right match {
                      case _: Literal => true
                      case rid: Identifier =>
                        Set("TRUE", "true", "FALSE", "false", "NULL", "nullptr").contains(rid.name)
                      case _ => false
                    }
                    assignments.arr += Obj(
                      "variable" -> ujson.Str(varName),
                      "value" -> ujson.Str(valueCode),
                      "line" -> ujson.Num(assignLine.toDouble),
                      "is_constant" -> ujson.Bool(isConstant)
                    )
                  case _ => // Skip complex LHS (e.g., array indexing)
                }
              }
            }
            // Function call detection
            if (!callName.startsWith("<operator>") && !callName.startsWith("<operators>")) {
              val calleeNames = Try(call.callee.filter(isUserMethod).name.toList).getOrElse(List.empty)
              calleeNames.foreach(n => viaCalls += n)
            }
          case _ =>
        }

        // ── Branch condition detection ──
        // Check if this node is a branch point (has branchInfo entry)
        branchInfo.get(node.id()) match {
          case Some((condExpr, trueBodyIds, condLine)) =>
            if (i + 1 < path.length) {
              val nextNode = path(i + 1)
              // Determine direction: is the next node in the true body?
              val tookTrueBranch = trueBodyIds.contains(nextNode.id())
              conditions.arr += Obj(
                "expression" -> ujson.Str(condExpr),
                "branch" -> ujson.Str(if (tookTrueBranch) "true" else "false"),
                "line" -> ujson.Num(condLine.toDouble)
              )
            }
          case None =>
            // Not a pre-identified branch point, but check if this node has
            // multiple successors (could be a switch or computed branch)
            val succs = succMap.getOrElse(node, List.empty)
            if (succs.size > 1 && i + 1 < path.length) {
              // Try to get condition from parent ControlStructure
              Try {
                val parentOpt = node._astIn.nextOption
                parentOpt match {
                  case Some(cs: ControlStructure) =>
                    val condList = cs.condition.toList
                    if (condList.nonEmpty) {
                      val condExpr = condList.head.code
                      val condLine = condList.head.lineNumber.getOrElse(-1)
                      val nextNode = path(i + 1)
                      val astChildren = cs.astChildren.toList
                      val trueBodyIds = mutable.Set[Long]()
                      if (astChildren.size > 1) {
                        Try(astChildren(1).ast.foreach(n => trueBodyIds += n.id()))
                      }
                      val tookTrueBranch = trueBodyIds.contains(nextNode.id())
                      conditions.arr += Obj(
                        "expression" -> ujson.Str(condExpr),
                        "branch" -> ujson.Str(if (tookTrueBranch) "true" else "false"),
                        "line" -> ujson.Num(condLine.toDouble)
                      )
                    }
                  case _ =>
                }
              }
            }
        }
      }

      // ── NEW: Collect enclosing conditions for the target node ──
      // The target node (last node on the path) may be inside if/while bodies.
      // Those enclosing conditions must be satisfied for the target to execute.
      val targetNode = path.last
      val enclosingConds = getEnclosingConditions(targetNode, method)
      val enclosingCondsArr = Arr()
      for ((expr, branch, line) <- enclosingConds) {
        enclosingCondsArr.arr += Obj(
          "expression" -> ujson.Str(expr),
          "branch" -> ujson.Str(branch),
          "line" -> ujson.Num(line.toDouble)
        )
      }

      Obj(
        "reachable" -> true,
        "conditions" -> conditions,
        "assignments" -> assignments,
        "enclosing_conditions" -> enclosingCondsArr,
        "interrupt_state_changes" -> interruptChanges,
        "path_length" -> ujson.Num(path.length.toDouble),
        "via_calls" -> Arr(viaCalls.map(ujson.Str(_)).toSeq: _*)
      )
  }
}

/**
 * Analyze path feasibility for a batch of atomicity violation candidates.
 * Decomposes each violation into 3 sub-paths and runs CFG reachability analysis.
 *
 * @param projectName  The CPG project name (already loaded via importCpg)
 * @param violationsJson JSON array of violation specs with sub_paths
 * @param interruptApisJson JSON array of interrupt API names (optional)
 * @return JSON string with path analysis results for each violation
 */
// ════════════════════════════════════════════════════
// SECTION 3: PATH FEASIBILITY ANALYSIS
// ════════════════════════════════════════════════════
def analyzePathFeasibility(
  projectName: String,
  violationsJson: String,
  interruptApisJson: String = "[]"
): String = {
  val violations = ujson.read(violationsJson).arr.toList
  val interruptApisRaw = Try(ujson.read(interruptApisJson).arr.map(_.str).toSet).getOrElse(Set.empty[String])

  // Merge with well-known interrupt APIs
  val defaultApis = Set(
    "__disable_irq", "__enable_irq",
    "__disable_interrupt", "__enable_interrupt",
    "__disable_fiq", "__enable_fiq",
    "__get_PRIMASK", "__set_PRIMASK",
    "taskENTER_CRITICAL", "taskEXIT_CRITICAL",
    "taskDISABLE_INTERRUPTS", "taskENABLE_INTERRUPTS",
    "EnterCriticalSection", "LeaveCriticalSection",
    "NVIC_DisableIRQ", "NVIC_EnableIRQ",
    "cli", "sei",
    "EA"  // 8051 global interrupt enable register
  )
  val directInterruptApis = interruptApisRaw ++ defaultApis

  // L4-05: Resolve wrapper functions — functions whose body is a single call to
  // a known interrupt API (e.g., `void DISABLE_INT() { __disable_irq(); }`).
  // This handles inline function wrappers and macro-like thin wrappers that Joern
  // preserves as separate methods in the CPG.
  val wrapperApis: Set[String] = Try {
    cpg.method.filter(isUserMethod).flatMap { m =>
      val calls = Try(m.call.filterNot(_.name.startsWith("<operator")).filterNot(_.name.startsWith("<operators")).toList)
        .getOrElse(List.empty)
      // A wrapper has exactly one non-operator call, and that call targets a known interrupt API
      if (calls.size == 1 && directInterruptApis.contains(calls.head.name)) {
        Some(m.name)
      } else {
        None
      }
    }.toSet
  }.getOrElse(Set.empty[String])

  val interruptApis = directInterruptApis ++ wrapperApis

  val cg = getCallGraph(cpg).toMap
  val globalVars = getAllGlobalVars(cpg).toSet
  val results = Arr()

  // Helper to create an empty sub-path result with default fields
  def emptySubPathResult(spType: String, reason: String): Obj = {
    Obj(
      "type" -> ujson.Str(spType), "reachable" -> false,
      "conditions" -> Arr(), "assignments" -> Arr(),
      "enclosing_conditions" -> Arr(),
      "caller_conditions" -> Arr(), "caller_assignments" -> Arr(),
      "caller_enclosing_conditions" -> Arr(),
      "call_chain" -> Arr(), "has_multiple_call_sites" -> false,
      "interrupt_state_changes" -> Arr(), "path_length" -> 0,
      "via_calls" -> Arr(), "reason" -> ujson.Str(reason)
    )
  }

  for (violation <- violations) {
    val violationId = violation("id").str
    val subPaths = violation("sub_paths").arr.toList

    // Extract violation metadata for short-circuit constraint analysis
    val mainAccess1Var = Try(subPaths.find(_("type").str == "main_to_access1")
      .flatMap(sp => sp.obj.get("target_variable").map(_.str))).getOrElse(None)
    val mainAccess2Var = Try(subPaths.find(_("type").str == "access1_to_access2")
      .flatMap(sp => sp.obj.get("to_variable").map(_.str))).getOrElse(None)
    val mainAccess1Line = Try(subPaths.find(_("type").str == "main_to_access1")
      .map(_("target_line").num.toInt)).getOrElse(None)
    val mainAccess2Line = Try(subPaths.find(_("type").str == "access1_to_access2")
      .map(_("to_line").num.toInt)).getOrElse(None)

    val subPathResults = Arr()

    // Track SP1 result for building state_at_preemption
    var sp1Result: Option[Obj] = None

    for (sp <- subPaths) {
      val spType = sp("type").str

      val spResult: Obj = spType match {
        case "main_to_access1" =>
          val funcName = sp("function").str
          val entryLine = sp("entry_line").num.toInt
          val targetLine = sp("target_line").num.toInt
          val entryFunc = sp.obj.get("entry_function").map(_.str).getOrElse(funcName)

          // If function != entry_function, check call graph reachability first
          if (funcName != entryFunc) {
            val reachable = getRelatedFuncs(cg, entryFunc).contains(funcName)
            if (!reachable) {
              emptySubPathResult(spType, s"$funcName not reachable from entry $entryFunc via call graph")
            } else {
              // Analyze within the target function
              val methods = cpg.method.nameExact(funcName).toList
              if (methods.isEmpty) {
                emptySubPathResult(spType, s"method $funcName not found in CPG")
              } else {
                val r = cfgReachability(methods.head, -1, targetLine, interruptApis)
                scopeResultLocals(r, funcName, globalVars)
                r("type") = ujson.Str(spType)
                r("via_calls") = Arr((r("via_calls").arr.map(_.str).toSet + s"(entry:$entryFunc)").map(ujson.Str(_)).toSeq: _*)

                // NEW: Collect caller-side conditions along the call chain
                val callerData = getCallerConditions(cg, entryFunc, funcName, interruptApis, globalVars)
                r("caller_conditions") = callerData("caller_conditions")
                r("caller_assignments") = callerData("caller_assignments")
                r("caller_enclosing_conditions") = callerData("caller_enclosing_conditions")
                r("call_chain") = callerData("call_chain")
                r("has_multiple_call_sites") = callerData("has_multiple_call_sites")

                r
              }
            }
          } else {
            val methods = cpg.method.nameExact(funcName).toList
            if (methods.isEmpty) {
              emptySubPathResult(spType, s"method $funcName not found in CPG")
            } else {
              val r = cfgReachability(methods.head, entryLine, targetLine, interruptApis)
              scopeResultLocals(r, funcName, globalVars)
              r("type") = ujson.Str(spType)
              r
            }
          }

        case "isr_internal" =>
          val funcName = sp("function").str
          val access1Line = sp("access1_line").num.toInt
          val access2Line = sp("access2_line").num.toInt
          val entryFunc = sp.obj.get("entry_function").map(_.str).getOrElse(funcName)

          // Check reachability: ISR entry → access1, then access1 → access2
          val methods = cpg.method.nameExact(funcName).toList
          if (methods.isEmpty) {
            emptySubPathResult(spType, s"ISR method $funcName not found in CPG")
          } else {
            val method = methods.head

            // NEW: Collect ISR caller-side conditions if inter-procedural
            val isrCallerData = if (funcName != entryFunc) {
              Some(getCallerConditions(cg, entryFunc, funcName, interruptApis, globalVars))
            } else None

            // First: entry → access1
            val r1 = if (funcName != entryFunc) {
              val callReachable = getRelatedFuncs(cg, entryFunc).contains(funcName)
              if (!callReachable) {
                Obj("reachable" -> false, "reason" -> ujson.Str(s"$funcName not reachable from ISR entry $entryFunc"))
              } else {
                val r = cfgReachability(method, -1, access1Line, interruptApis)
                scopeResultLocals(r, funcName, globalVars)
                r
              }
            } else {
              val r = cfgReachability(method, -1, access1Line, interruptApis)
              scopeResultLocals(r, funcName, globalVars)
              r
            }

            // Helper: attach caller data to a result Obj
            def attachCallerData(result: Obj): Unit = {
              isrCallerData match {
                case Some(cd) =>
                  result("caller_conditions") = cd("caller_conditions")
                  result("caller_assignments") = cd("caller_assignments")
                  result("caller_enclosing_conditions") = cd("caller_enclosing_conditions")
                  result("call_chain") = cd("call_chain")
                  result("has_multiple_call_sites") = cd("has_multiple_call_sites")
                case None => // intra-procedural, no caller data
              }
            }

            if (!r1("reachable").bool) {
              val combined = emptySubPathResult(spType, s"ISR entry to access1 (L$access1Line) not reachable")
              combined("conditions") = r1.obj.getOrElse("conditions", Arr())
              combined("interrupt_state_changes") = r1.obj.getOrElse("interrupt_state_changes", Arr())
              combined("via_calls") = r1.obj.getOrElse("via_calls", Arr())
              attachCallerData(combined)
              combined
            } else {
              // Second: access1 → access2 (may be in same function or different)
              val r2 = cfgReachability(method, access1Line, access2Line, interruptApis)
              scopeResultLocals(r2, funcName, globalVars)
              if (!r2("reachable").bool) {
                val combined = emptySubPathResult(spType, s"ISR access1 (L$access1Line) to access2 (L$access2Line) not reachable")
                combined("reachable") = false
                combined("conditions") = Arr((r1("conditions").arr ++ r2("conditions").arr).toSeq: _*)
                combined("assignments") = Arr((r1.obj.getOrElse("assignments", Arr()).arr ++ r2.obj.getOrElse("assignments", Arr()).arr).toSeq: _*)
                combined("enclosing_conditions") = r2.obj.getOrElse("enclosing_conditions", Arr())
                combined("interrupt_state_changes") = Arr((r1("interrupt_state_changes").arr ++ r2("interrupt_state_changes").arr).toSeq: _*)
                combined("via_calls") = Arr((r1("via_calls").arr.map(_.str).toSet ++ r2("via_calls").arr.map(_.str).toSet).map(ujson.Str(_)).toSeq: _*)
                attachCallerData(combined)
                combined
              } else {
                val result = Obj(
                  "type" -> ujson.Str(spType),
                  "reachable" -> true,
                  "conditions" -> Arr((r1("conditions").arr ++ r2("conditions").arr).toSeq: _*),
                  "assignments" -> Arr((r1.obj.getOrElse("assignments", Arr()).arr ++ r2.obj.getOrElse("assignments", Arr()).arr).toSeq: _*),
                  "enclosing_conditions" -> r2.obj.getOrElse("enclosing_conditions", Arr()),
                  "interrupt_state_changes" -> Arr((r1("interrupt_state_changes").arr ++ r2("interrupt_state_changes").arr).toSeq: _*),
                  "path_length" -> ujson.Num((r1("path_length").num + r2("path_length").num)),
                  "via_calls" -> Arr((r1("via_calls").arr.map(_.str).toSet ++ r2("via_calls").arr.map(_.str).toSet).map(ujson.Str(_)).toSeq: _*)
                )
                attachCallerData(result)
                result
              }
            }
          }

        case "access1_to_access2" =>
          val funcName = sp("function").str
          val fromLine = sp("from_line").num.toInt
          val toLine = sp("to_line").num.toInt

          val methods = cpg.method.nameExact(funcName).toList
          if (methods.isEmpty) {
            emptySubPathResult(spType, s"method $funcName not found in CPG")
          } else {
            val r = cfgReachability(methods.head, fromLine, toLine, interruptApis)
            scopeResultLocals(r, funcName, globalVars)
            r("type") = ujson.Str(spType)
            r
          }

        case other =>
          emptySubPathResult(other, s"unknown sub-path type: $other")
      }

      // Track SP1 for state_at_preemption
      if (sp("type").str == "main_to_access1") {
        sp1Result = Some(spResult)
      }

      subPathResults.arr += spResult
    }

    // ── NEW: Compute state_at_preemption ──
    // Combines SP1's accumulated conditions/assignments with short-circuit constraints
    // to model the global state at the preemption point (between main_access1 and main_access2).
    val stateAtPreemption = Obj()

    sp1Result match {
      case Some(sp1) if sp1("reachable").bool =>
        // Active conditions from SP1 path (branch conditions that were decided along the path)
        stateAtPreemption("active_conditions") = sp1.obj.getOrElse("conditions", Arr())
        // Assignments along SP1 path
        stateAtPreemption("active_assignments") = sp1.obj.getOrElse("assignments", Arr())
        // Enclosing conditions of the target node (access1)
        stateAtPreemption("enclosing_conditions") = sp1.obj.getOrElse("enclosing_conditions", Arr())

        // NEW: Propagate caller-side conditions from SP1 into preemption state
        stateAtPreemption("caller_conditions") = sp1.obj.getOrElse("caller_conditions", Arr())
        stateAtPreemption("caller_assignments") = sp1.obj.getOrElse("caller_assignments", Arr())
        stateAtPreemption("caller_enclosing_conditions") = sp1.obj.getOrElse("caller_enclosing_conditions", Arr())

        // Short-circuit constraints: extract && chain pre-conditions for access2.
        // When access2 is inside `if (A && B && C) { ... access2 ... }`, reaching
        // access2 requires A, B, C to all be true. We extract conditions preceding
        // the sub-expression that references access2's variable.
        //
        // Previously limited to same-line accesses (a1Line == a2Line), which missed
        // 99% of real cases like `if(flag && ptr) { process(buf); }` where the
        // condition and body are on different lines. Now we use the enclosing
        // condition line of access2 (from SP1/SP3 enclosing_conditions) to find the
        // relevant && chain, regardless of whether the two accesses share a line.
        val shortCircuitArr = Arr()
        (mainAccess2Var) match {
          case Some(var2) =>
            // Determine the condition line: prefer enclosing condition of access2
            // (from SP1 enclosing_conditions), fall back to access1 line for same-line case
            val enclosingCondLines = sp1.obj.getOrElse("enclosing_conditions", Arr()).arr
              .flatMap(ec => Try(ec("line").num.toInt).toOption)
              .toList
            // Also check SP3's enclosing_conditions (access2 may have its own enclosing)
            val sp3Enclosing = Try(subPathResults.arr
              .find(sp => sp("type").str == "access1_to_access2")
              .map(_.obj.getOrElse("enclosing_conditions", Arr()).arr
                .flatMap(ec => Try(ec("line").num.toInt).toOption)
                .toList)
              .getOrElse(List.empty)).getOrElse(List.empty)

            val candidateCondLines = (enclosingCondLines ++ sp3Enclosing).distinct

            val funcName = Try(subPaths.find(_("type").str == "main_to_access1")
              .map(_("function").str)).getOrElse(None)
            // Also consider the access2 function (may differ from access1 in cross-function cases)
            val funcName2 = Try(subPaths.find(_("type").str == "access1_to_access2")
              .map(_("function").str)).getOrElse(funcName)
            val targetFn = funcName2.orElse(funcName)

            targetFn.foreach { fn =>
              val methods = cpg.method.nameExact(fn).toList
              if (methods.nonEmpty) {
                // Try each enclosing condition line to find && chains
                for (condLine <- candidateCondLines) {
                  val scConstraintsRaw = getShortCircuitConstraints(methods.head, condLine, var2, true)
                  val scConstraints = scopeConditionTuples(scConstraintsRaw, fn, globalVars)
                  for ((expr, branch, line) <- scConstraints) {
                    shortCircuitArr.arr += Obj(
                      "expression" -> ujson.Str(expr),
                      "branch" -> ujson.Str(branch),
                      "line" -> ujson.Num(line.toDouble)
                    )
                  }
                }
                // Also try access1 line for same-line scenario (backward compatible)
                mainAccess1Line.foreach { a1Line =>
                  if (!candidateCondLines.contains(a1Line)) {
                    val scConstraintsRaw = getShortCircuitConstraints(methods.head, a1Line, var2, true)
                    val scConstraints = scopeConditionTuples(scConstraintsRaw, fn, globalVars)
                    for ((expr, branch, line) <- scConstraints) {
                      shortCircuitArr.arr += Obj(
                        "expression" -> ujson.Str(expr),
                        "branch" -> ujson.Str(branch),
                        "line" -> ujson.Num(line.toDouble)
                      )
                    }
                  }
                }
              }
            }
          case _ => // Missing variable info — no short-circuit constraints
        }
        stateAtPreemption("short_circuit_constraints") = shortCircuitArr

      case _ =>
        // SP1 not reachable or not available — empty preemption state
        stateAtPreemption("active_conditions") = Arr()
        stateAtPreemption("active_assignments") = Arr()
        stateAtPreemption("enclosing_conditions") = Arr()
        stateAtPreemption("caller_conditions") = Arr()
        stateAtPreemption("caller_assignments") = Arr()
        stateAtPreemption("caller_enclosing_conditions") = Arr()
        stateAtPreemption("short_circuit_constraints") = Arr()
    }

    results.arr += Obj(
      "id" -> ujson.Str(violationId),
      "sub_paths" -> subPathResults,
      "state_at_preemption" -> stateAtPreemption
    )
  }

  ujson.write(Obj("results" -> results), indent = 2)
}

// importCpg("D:/dev_code/code-query-by-joern/joern-cli/target/universal/joern-cli/cpgs/print.bin", "print")
// ddSlice(cpg, cpg.call("printf").argument.head.asInstanceOf[CfgNode].toList)
