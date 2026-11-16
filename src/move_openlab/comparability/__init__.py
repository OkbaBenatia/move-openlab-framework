"""Semantic comparability of optimization experiments.

An experiment cell ``E = (I, P, C, M, V, ENV, R)``: instance, problem semantics, execution configuration, method,
evaluation contract, environment and results. :func:`move_openlab.comparability.contract.check` decides, for a stated
claim, whether two cells are directly comparable, conditionally comparable or incompatible — and explains why.
"""
from .contract import CLAIMS, CONDITIONAL, DIRECT, INCOMPATIBLE, check, check_all  # noqa: F401
from .model import cell  # noqa: F401
