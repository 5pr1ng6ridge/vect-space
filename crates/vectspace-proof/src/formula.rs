//! The constrained formula language shared by Lean generation and KaTeX display.
//! Strict input never reaches either emitter without being parsed into this AST.

use std::collections::BTreeSet;

const MAX_DEPTH: usize = 64;
const MAX_DISPLAY_CHARS: usize = 16_384;
const RESERVED: &[&str] = &[
    "fun",
    "by",
    "have",
    "show",
    "from",
    "let",
    "in",
    "at",
    "do",
    "if",
    "then",
    "else",
    "match",
    "with",
    "end",
    "sorry",
    "theorem",
    "def",
    "example",
    "open",
    "import",
    "namespace",
    "section",
    "variable",
    "universe",
    "axiom",
    "instance",
    "structure",
    "class",
    "where",
    "calc",
    "suffices",
    "obtain",
    "forall",
    "exists",
    "Type",
    "Sort",
    "Prop",
    "Nat",
    "Int",
    "True",
    "False",
    "not",
];

/// A parsed formula (proposition, term or type).
#[derive(Debug, Clone, PartialEq)]
pub struct Formula {
    expr: Expr,
}

#[derive(Debug, Clone, PartialEq)]
enum Expr {
    Name(String),
    Number(String),
    Constant(&'static str),
    Hole,
    Unary(Unary, Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
    Apply(Box<Expr>, Box<Expr>),
    Ascribe(Box<Expr>, Box<Expr>),
    Quantify(bool, Vec<Binder>, Box<Expr>),
}

#[derive(Debug, Clone, PartialEq)]
struct Binder {
    names: Vec<String>,
    ty: Option<Expr>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unary {
    Not,
    Negate,
    Coerce,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Iff,
    Arrow,
    Or,
    And,
    Eq,
    Ne,
    Lt,
    Gt,
    Le,
    Ge,
    Divides,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Assoc {
    Left,
    Right,
    None,
}

impl Op {
    fn precedence(self) -> u8 {
        match self {
            Self::Iff => 20,
            Self::Arrow => 25,
            Self::Or => 30,
            Self::And => 35,
            Self::Eq | Self::Ne | Self::Lt | Self::Gt | Self::Le | Self::Ge | Self::Divides => 50,
            Self::Add | Self::Sub => 65,
            Self::Mul | Self::Div | Self::Mod => 70,
            Self::Pow => 75,
        }
    }

    fn assoc(self) -> Assoc {
        match self {
            Self::Iff
            | Self::Eq
            | Self::Ne
            | Self::Lt
            | Self::Gt
            | Self::Le
            | Self::Ge
            | Self::Divides => Assoc::None,
            Self::Arrow | Self::Or | Self::And | Self::Pow => Assoc::Right,
            _ => Assoc::Left,
        }
    }

    fn lean(self) -> &'static str {
        match self {
            Self::Iff => "↔",
            Self::Arrow => "→",
            Self::Or => "∨",
            Self::And => "∧",
            Self::Eq => "=",
            Self::Ne => "≠",
            Self::Lt => "<",
            Self::Gt => ">",
            Self::Le => "≤",
            Self::Ge => "≥",
            Self::Divides => "∣",
            Self::Add => "+",
            Self::Sub => "-",
            Self::Mul => "*",
            Self::Div => "/",
            Self::Mod => "%",
            Self::Pow => "^",
        }
    }

    fn latex(self, type_position: bool) -> &'static str {
        match self {
            Self::Iff => r"\Leftrightarrow",
            Self::Arrow if type_position => r"\to",
            Self::Arrow => r"\Rightarrow",
            Self::Or => r"\lor",
            Self::And => r"\land",
            Self::Ne => r"\neq",
            Self::Le => r"\le",
            Self::Ge => r"\ge",
            Self::Divides => r"\mid",
            Self::Mul => r"\cdot",
            Self::Mod => r"\bmod",
            _ => self.lean(),
        }
    }
}

/// An error with a Chinese message and a Unicode code point offset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormulaError {
    pub message: String,
    pub offset: usize,
}

fn error(offset: usize, message: impl Into<String>) -> FormulaError {
    FormulaError {
        message: message.into(),
        offset,
    }
}

fn name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || (('α'..='ω').contains(&c) && c != 'λ')
}

fn name_rest(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '\'' || ('₀'..='₉').contains(&c)
}

fn name_shape(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(name_start) && chars.all(name_rest) && name.chars().count() <= 32
}

fn reserved(name: &str) -> bool {
    RESERVED.contains(&name) || name.starts_with("vs") || name.starts_with("VS")
}

/// Identifier rules plus the reserved-word list; used for player binder names.
pub fn is_valid_name(name: &str) -> bool {
    name_shape(name) && !reserved(name)
}

#[derive(Debug, Clone, PartialEq)]
enum TokenKind {
    Word(String),
    Number(String),
    Op(Op),
    Not,
    Coerce,
    Forall,
    Exists,
    Hole,
    Left,
    Right,
    Colon,
    Comma,
    End,
}

#[derive(Debug, Clone)]
struct Token {
    kind: TokenKind,
    offset: usize,
}

fn lex(src: &str, display: bool) -> Result<Vec<Token>, FormulaError> {
    let chars: Vec<char> = src.chars().collect();
    let limit = if display {
        MAX_DISPLAY_CHARS
    } else {
        crate::graph::MAX_FORMULA_CHARS
    };
    if chars.len() > limit {
        return Err(error(limit, format!("公式不能超过 {limit} 个字符")));
    }
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let offset = i;
        let c = chars[i];
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        let aliases = [
            ("<->", Op::Iff),
            ("->", Op::Arrow),
            ("/\\", Op::And),
            ("\\/", Op::Or),
            ("!=", Op::Ne),
            ("<=", Op::Le),
            (">=", Op::Ge),
        ];
        if let Some((alias, op)) = aliases.iter().find(|(alias, _)| {
            chars[i..]
                .iter()
                .copied()
                .zip(alias.chars())
                .all(|(a, b)| a == b)
                && chars.len() - i >= alias.len()
        }) {
            i += alias.len();
            tokens.push(Token {
                kind: TokenKind::Op(*op),
                offset,
            });
            continue;
        }
        let kind = if name_start(c) {
            i += 1;
            while i < chars.len() && name_rest(chars[i]) {
                i += 1;
            }
            if display {
                while i + 1 < chars.len() && chars[i] == '.' && name_start(chars[i + 1]) {
                    i += 2;
                    while i < chars.len() && name_rest(chars[i]) {
                        i += 1;
                    }
                }
            }
            let word: String = chars[offset..i].iter().collect();
            match word.as_str() {
                "forall" => TokenKind::Forall,
                "exists" => TokenKind::Exists,
                "sorry" if display => TokenKind::Hole,
                _ => TokenKind::Word(word),
            }
        } else if c.is_ascii_digit() {
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i - offset > 18 {
                return Err(error(offset, "数字不能超过 18 位"));
            }
            TokenKind::Number(chars[offset..i].iter().collect())
        } else if display && c == '?' {
            i += 1;
            if chars.get(i) == Some(&'_') {
                i += 1;
            } else {
                if !chars.get(i).is_some_and(|c| name_start(*c)) {
                    return Err(error(offset, "无法识别占位符"));
                }
                i += 1;
                while i < chars.len() && name_rest(chars[i]) {
                    i += 1;
                }
                if chars.get(i) != Some(&'.') {
                    return Err(error(offset, "无法识别占位符"));
                }
                i += 1;
                let digits = i;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
                if i == digits {
                    return Err(error(offset, "无法识别占位符"));
                }
            }
            TokenKind::Hole
        } else {
            i += 1;
            match c {
                '∀' => TokenKind::Forall,
                '∃' => TokenKind::Exists,
                '¬' | '~' => TokenKind::Not,
                '↑' if display => TokenKind::Coerce,
                '_' if display => TokenKind::Hole,
                '(' => TokenKind::Left,
                ')' => TokenKind::Right,
                ':' => TokenKind::Colon,
                ',' => TokenKind::Comma,
                'ℕ' => TokenKind::Word("Nat".into()),
                'ℤ' => TokenKind::Word("Int".into()),
                '↔' => TokenKind::Op(Op::Iff),
                '→' => TokenKind::Op(Op::Arrow),
                '∨' => TokenKind::Op(Op::Or),
                '∧' => TokenKind::Op(Op::And),
                '=' => TokenKind::Op(Op::Eq),
                '≠' => TokenKind::Op(Op::Ne),
                '<' => TokenKind::Op(Op::Lt),
                '>' => TokenKind::Op(Op::Gt),
                '≤' => TokenKind::Op(Op::Le),
                '≥' => TokenKind::Op(Op::Ge),
                '∣' | '|' => TokenKind::Op(Op::Divides),
                '+' => TokenKind::Op(Op::Add),
                '-' => TokenKind::Op(Op::Sub),
                '*' => TokenKind::Op(Op::Mul),
                '/' => TokenKind::Op(Op::Div),
                '%' => TokenKind::Op(Op::Mod),
                '^' => TokenKind::Op(Op::Pow),
                _ => return Err(error(offset, format!("不支持字符 `{c}`"))),
            }
        };
        tokens.push(Token { kind, offset });
    }
    tokens.push(Token {
        kind: TokenKind::End,
        offset: chars.len(),
    });
    Ok(tokens)
}

struct Parser<'a> {
    tokens: Vec<Token>,
    cursor: usize,
    display: bool,
    declared: &'a dyn Fn(&str) -> bool,
    bound: Vec<String>,
}

impl Parser<'_> {
    fn token(&self) -> &Token {
        &self.tokens[self.cursor]
    }

    fn take(&mut self) -> Token {
        let token = self.token().clone();
        if token.kind != TokenKind::End {
            self.cursor += 1;
        }
        token
    }

    fn expect(&mut self, kind: TokenKind, message: &str) -> Result<(), FormulaError> {
        if self.token().kind != kind {
            return Err(error(self.token().offset, message));
        }
        self.take();
        Ok(())
    }

    fn validate_name(&self, name: &str, offset: usize) -> Result<(), FormulaError> {
        if reserved(name) {
            return Err(error(offset, format!("名称 `{name}` 是保留字")));
        }
        if !name_shape(name) {
            return Err(error(offset, format!("名称 `{name}` 不符合命名规则")));
        }
        Ok(())
    }

    fn expr(&mut self, min: u8, depth: usize) -> Result<Expr, FormulaError> {
        if depth > MAX_DEPTH {
            return Err(error(self.token().offset, "公式嵌套过深"));
        }
        let token = self.take();
        let mut lhs = match token.kind {
            TokenKind::Word(name) => match name.as_str() {
                "Prop" => Expr::Constant("Prop"),
                "Nat" => Expr::Constant("Nat"),
                "Int" => Expr::Constant("Int"),
                "True" => Expr::Constant("True"),
                "False" => Expr::Constant("False"),
                _ => {
                    if !self.display {
                        self.validate_name(&name, token.offset)?;
                        if !self.bound.contains(&name) && !(self.declared)(&name) {
                            return Err(error(token.offset, format!("未知名称 `{name}`")));
                        }
                    } else if name
                        .split('.')
                        .any(|part| !name_shape(part) || reserved(part))
                    {
                        // Namespace segments may be the built-in type names.
                        if !name.contains('.') || name.split('.').any(|part| !name_shape(part)) {
                            return Err(error(token.offset, format!("无法显示名称 `{name}`")));
                        }
                    }
                    Expr::Name(name)
                }
            },
            TokenKind::Number(n) => Expr::Number(n),
            TokenKind::Hole => Expr::Hole,
            TokenKind::Left => {
                let value = self.expr(0, depth + 1)?;
                let value = if self.token().kind == TokenKind::Colon {
                    self.take();
                    let ty = self.expr(0, depth + 1)?;
                    Expr::Ascribe(Box::new(value), Box::new(ty))
                } else {
                    value
                };
                self.expect(TokenKind::Right, "缺少右括号")?;
                value
            }
            TokenKind::Not => Expr::Unary(Unary::Not, Box::new(self.expr(40, depth + 1)?)),
            TokenKind::Op(Op::Sub) => {
                Expr::Unary(Unary::Negate, Box::new(self.expr(75, depth + 1)?))
            }
            TokenKind::Coerce => Expr::Unary(Unary::Coerce, Box::new(self.expr(100, depth + 1)?)),
            TokenKind::Forall => self.quantify(true, depth + 1)?,
            TokenKind::Exists => self.quantify(false, depth + 1)?,
            _ => return Err(error(token.offset, "这里需要一个表达式")),
        };
        let mut non_assoc = None;
        loop {
            if let TokenKind::Op(op) = self.token().kind {
                let prec = op.precedence();
                if prec < min {
                    break;
                }
                if non_assoc == Some(prec) {
                    return Err(error(
                        self.token().offset,
                        "此运算符不能连续使用，请添加括号",
                    ));
                }
                self.take();
                let rhs_min = prec + u8::from(op.assoc() != Assoc::Right);
                let rhs = self.expr(rhs_min, depth + 1)?;
                non_assoc = (op.assoc() == Assoc::None).then_some(prec);
                lhs = Expr::Binary(op, Box::new(lhs), Box::new(rhs));
            } else if min <= 100 && self.starts_argument() {
                if !matches!(lhs, Expr::Name(_) | Expr::Apply(..) | Expr::Ascribe(..)) {
                    return Err(error(self.token().offset, "这里只能对函数名称使用参数"));
                }
                let rhs = self.expr(101, depth + 1)?;
                lhs = Expr::Apply(Box::new(lhs), Box::new(rhs));
            } else {
                break;
            }
            if lhs.depth() > MAX_DEPTH {
                return Err(error(token.offset, "公式嵌套过深"));
            }
        }
        if lhs.depth() > MAX_DEPTH {
            return Err(error(token.offset, "公式嵌套过深"));
        }
        Ok(lhs)
    }

    fn starts_argument(&self) -> bool {
        matches!(
            self.token().kind,
            TokenKind::Word(_)
                | TokenKind::Number(_)
                | TokenKind::Hole
                | TokenKind::Left
                | TokenKind::Coerce
        )
    }

    fn binder_names(&mut self) -> Result<Vec<String>, FormulaError> {
        let mut names = Vec::new();
        while let TokenKind::Word(name) = &self.token().kind {
            let name = name.clone();
            self.validate_name(&name, self.token().offset)?;
            self.take();
            names.push(name);
        }
        if names.is_empty() {
            return Err(error(self.token().offset, "这里需要一个绑定名称"));
        }
        Ok(names)
    }

    fn quantify(&mut self, forall: bool, depth: usize) -> Result<Expr, FormulaError> {
        if depth > MAX_DEPTH {
            return Err(error(self.token().offset, "公式嵌套过深"));
        }
        let bound_start = self.bound.len();
        let mut binders = Vec::new();
        if self.token().kind == TokenKind::Left {
            while self.token().kind == TokenKind::Left {
                self.take();
                let names = self.binder_names()?;
                self.expect(TokenKind::Colon, "绑定组缺少类型")?;
                let ty = self.expr(0, depth + 1)?;
                self.expect(TokenKind::Right, "缺少右括号")?;
                self.bound.extend(names.iter().cloned());
                binders.push(Binder {
                    names,
                    ty: Some(ty),
                });
            }
        } else {
            let names = self.binder_names()?;
            let ty = if self.token().kind == TokenKind::Colon {
                self.take();
                Some(self.expr(0, depth + 1)?)
            } else {
                None
            };
            self.bound.extend(names.iter().cloned());
            binders.push(Binder { names, ty });
        }
        self.expect(TokenKind::Comma, "量词后缺少逗号")?;
        let body = self.expr(0, depth + 1)?;
        self.bound.truncate(bound_start);
        Ok(Expr::Quantify(forall, binders, Box::new(body)))
    }
}

fn parse(
    src: &str,
    declared: &dyn Fn(&str) -> bool,
    display: bool,
) -> Result<Formula, FormulaError> {
    let mut parser = Parser {
        tokens: lex(src, display)?,
        cursor: 0,
        display,
        declared,
        bound: Vec::new(),
    };
    let expr = parser.expr(0, 0)?;
    if parser.token().kind != TokenKind::End {
        return Err(error(parser.token().offset, "表达式后有多余内容"));
    }
    Ok(Formula { expr })
}

/// Strict parse. All free names must be declared; quantifier binders are local.
pub fn parse_formula(
    src: &str,
    is_declared: &dyn Fn(&str) -> bool,
) -> Result<Formula, FormulaError> {
    parse(src, is_declared, false)
}

/// Lenient parse of Lean pretty-printer output; `None` when not understood.
pub fn parse_display(src: &str) -> Option<Formula> {
    parse(src, &|_| true, true).ok()
}

/// `parse_display(text).map(to_latex)`.
pub fn display_latex(text: &str) -> Option<String> {
    parse_display(text).map(|formula| formula.to_latex())
}

impl Formula {
    /// Canonical, fully parenthesized Lean source.
    pub fn to_lean(&self) -> String {
        self.expr.lean()
    }

    /// LaTeX for KaTeX, implication as `\Rightarrow`.
    pub fn to_latex(&self) -> String {
        self.expr.latex(false, 0)
    }

    /// LaTeX for a declared type, with arrows as `\to`.
    pub fn to_latex_type(&self) -> String {
        self.expr.latex(true, 0)
    }

    /// Free identifiers (not bound inside this formula).
    pub fn free_names(&self) -> BTreeSet<String> {
        let mut names = BTreeSet::new();
        self.expr.collect_names(&mut Vec::new(), &mut names);
        names
    }
}

impl Expr {
    fn depth(&self) -> usize {
        1 + match self {
            Self::Unary(_, a) => a.depth(),
            Self::Binary(_, a, b) | Self::Apply(a, b) | Self::Ascribe(a, b) => {
                a.depth().max(b.depth())
            }
            Self::Quantify(_, binders, body) => binders
                .iter()
                .filter_map(|b| b.ty.as_ref())
                .map(Self::depth)
                .max()
                .unwrap_or(0)
                .max(body.depth()),
            _ => 0,
        }
    }

    fn precedence(&self) -> u8 {
        match self {
            Self::Quantify(..) => 0,
            Self::Binary(op, ..) => op.precedence(),
            Self::Unary(Unary::Not, _) => 40,
            Self::Unary(Unary::Negate, _) => 75,
            _ => 100,
        }
    }

    fn lean(&self) -> String {
        match self {
            Self::Name(name) | Self::Number(name) => name.clone(),
            Self::Constant(name) => (*name).into(),
            Self::Hole => "_".into(),
            Self::Unary(op, value) => {
                let op = match op {
                    Unary::Not => "¬",
                    Unary::Negate => "-",
                    Unary::Coerce => "↑",
                };
                format!("({op}{})", value.lean())
            }
            Self::Binary(op, a, b) => format!("({} {} {})", a.lean(), op.lean(), b.lean()),
            Self::Apply(f, arg) => format!("({} {})", f.lean(), arg.lean()),
            Self::Ascribe(value, ty) => format!("({} : {})", value.lean(), ty.lean()),
            Self::Quantify(forall, binders, body) => {
                let quantifier = if *forall { "∀" } else { "∃" };
                let binders = binders
                    .iter()
                    .map(|binder| {
                        let names = binder.names.join(" ");
                        match &binder.ty {
                            Some(ty) => format!("({names} : {})", ty.lean()),
                            None => names,
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("({quantifier} {binders}, {})", body.lean())
            }
        }
    }

    fn latex(&self, type_position: bool, min: u8) -> String {
        let text = match self {
            Self::Name(name) => latex_name(name),
            Self::Number(number) => number.clone(),
            Self::Constant(name) => match *name {
                "Nat" => r"\mathbb{N}",
                "Int" => r"\mathbb{Z}",
                "True" => r"\top",
                "False" => r"\bot",
                _ => r"\mathrm{Prop}",
            }
            .into(),
            Self::Hole => r"\square".into(),
            Self::Unary(Unary::Coerce, value) => value.latex(type_position, 100),
            Self::Unary(op, value) => {
                let (symbol, prec) = if *op == Unary::Not {
                    (r"\neg ", 40)
                } else {
                    ("-", 75)
                };
                let extra = u8::from(
                    matches!(value.as_ref(), Self::Unary(Unary::Negate, _)) && *op == Unary::Negate,
                );
                format!("{symbol}{}", value.latex(type_position, prec + extra))
            }
            Self::Binary(Op::Pow, a, b) => {
                format!(
                    "{{{}}}^{{{}}}",
                    a.latex(type_position, 76),
                    b.latex(type_position, 0)
                )
            }
            Self::Binary(op, a, b) => {
                let prec = op.precedence();
                let left_min = prec + u8::from(op.assoc() != Assoc::Left);
                let right_min = prec + u8::from(op.assoc() != Assoc::Right);
                format!(
                    "{} {} {}",
                    a.latex(type_position, left_min),
                    op.latex(type_position),
                    b.latex(type_position, right_min)
                )
            }
            Self::Apply(..) => {
                let mut args = Vec::new();
                let mut head = self;
                while let Self::Apply(f, arg) = head {
                    args.push(arg.latex(type_position, 0));
                    head = f;
                }
                args.reverse();
                format!("{}({})", head.latex(type_position, 100), args.join(", "))
            }
            Self::Ascribe(value, ty) => format!(
                r"\left({} : {}\right)",
                value.latex(type_position, 0),
                ty.latex(true, 0)
            ),
            Self::Quantify(forall, binders, body) => {
                let symbol = if *forall { r"\forall" } else { r"\exists" };
                let binders = binders
                    .iter()
                    .map(|binder| {
                        let names = binder
                            .names
                            .iter()
                            .map(|name| latex_name(name))
                            .collect::<Vec<_>>()
                            .join(r"\, ");
                        match &binder.ty {
                            Some(ty) => format!(r"{names} \in {}", ty.latex(true, 0)),
                            None => names,
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(r",\ ");
                format!(r"{symbol} {binders},\ {}", body.latex(type_position, 0))
            }
        };
        if self.precedence() < min {
            format!(r"\left({text}\right)")
        } else {
            text
        }
    }

    fn collect_names(&self, bound: &mut Vec<String>, names: &mut BTreeSet<String>) {
        match self {
            Self::Name(name) => {
                if !bound.contains(name) {
                    names.insert(name.clone());
                }
            }
            Self::Unary(_, value) => value.collect_names(bound, names),
            Self::Binary(_, a, b) | Self::Apply(a, b) | Self::Ascribe(a, b) => {
                a.collect_names(bound, names);
                b.collect_names(bound, names);
            }
            Self::Quantify(_, binders, body) => {
                let start = bound.len();
                for binder in binders {
                    if let Some(ty) = &binder.ty {
                        ty.collect_names(bound, names);
                    }
                    bound.extend(binder.names.iter().cloned());
                }
                body.collect_names(bound, names);
                bound.truncate(start);
            }
            _ => {}
        }
    }
}

fn greek(c: char) -> Option<&'static str> {
    Some(match c {
        'α' => "alpha",
        'β' => "beta",
        'γ' => "gamma",
        'δ' => "delta",
        'ε' => "epsilon",
        'ζ' => "zeta",
        'η' => "eta",
        'θ' => "theta",
        'ι' => "iota",
        'κ' => "kappa",
        'μ' => "mu",
        'ν' => "nu",
        'ξ' => "xi",
        'ο' => "omicron",
        'π' => "pi",
        'ρ' => "rho",
        'ς' => "varsigma",
        'σ' => "sigma",
        'τ' => "tau",
        'υ' => "upsilon",
        'φ' => "phi",
        'χ' => "chi",
        'ψ' => "psi",
        'ω' => "omega",
        _ => return None,
    })
}

fn latex_name(name: &str) -> String {
    let dotted = name.contains('.');
    let name = name.rsplit('.').next().unwrap_or(name);
    let mut chars: Vec<char> = name.chars().collect();
    let mut primes = 0;
    while chars.last() == Some(&'\'') {
        chars.pop();
        primes += 1;
    }
    let mut digits = Vec::new();
    while chars
        .last()
        .is_some_and(|c| c.is_ascii_digit() || ('₀'..='₉').contains(c))
    {
        let c = chars.pop().expect("checked last character");
        digits.push(if c.is_ascii_digit() {
            c
        } else {
            char::from(b'0' + (c as u32 - '₀' as u32) as u8)
        });
    }
    if !digits.is_empty() && chars.last() == Some(&'_') {
        chars.pop();
    }
    let escaped = chars
        .iter()
        .map(|c| match c {
            '_' => r"\_".into(),
            '\'' => r"\prime{}".into(),
            _ => greek(*c).map_or_else(|| c.to_string(), |g| format!(r"\{g}{{}}")),
        })
        .collect::<String>();
    let mut result = if dotted {
        format!(r"\operatorname{{{escaped}}}")
    } else if chars.len() == 1 {
        greek(chars[0]).map_or(escaped, |g| format!(r"\{g}"))
    } else {
        format!(r"\mathrm{{{escaped}}}")
    };
    if !digits.is_empty() {
        digits.reverse();
        result.push_str(&format!("_{{{}}}", digits.iter().collect::<String>()));
    }
    if primes > 0 {
        result.push_str(&format!("^{{{}}}", r"\prime".repeat(primes)));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strict(src: &str) -> Formula {
        parse_formula(src, &|_| true).unwrap_or_else(|err| panic!("{src}: {err:?}"))
    }

    #[test]
    fn formula_strict_accepts_language() {
        for src in [
            "p /\\ q -> q \\/ p",
            "~p <-> q",
            "a != b",
            "a <= b",
            "a >= b",
            "a | b",
            "forall x y : Nat, P x y",
            "exists x, P x",
            "∀ (a b : Nat) (c : Int), a ≤ b",
            "(a : ℕ)",
            "Nat -> Int -> Prop",
            "True",
            "False",
            "α1 + h₁",
            "f (a + b) c",
            "a / b % 2 = -a ^ 2",
            "123456789012345678",
            "ℤ",
        ] {
            strict(src);
        }
    }

    #[test]
    fn formula_strict_rejects_injection_and_unknown_names() {
        for src in [
            "sorry",
            "by exact h",
            "fun x => x",
            "#eval 1",
            "\"str\"",
            "h.1",
            "Nat.succ a",
            "vsH0",
            "VSx",
            "λ",
            "Type",
            "not p",
            "p; exact h",
            "?_",
            "?m.12",
            "↑a",
            "a := b",
            "1 2",
            "p ↔ q ↔ p",
            "a < b ≤ c",
            "1234567890123456789",
        ] {
            assert!(parse_formula(src, &|_| true).is_err(), "accepted {src}");
        }
        let err = parse_formula("p ∧ x", &|name| name == "p").unwrap_err();
        assert_eq!(err, error(4, "未知名称 `x`"));
        assert_eq!(
            parse_formula("fun", &|_| true).unwrap_err(),
            error(0, "名称 `fun` 是保留字")
        );
        assert_eq!(
            parse_formula("(p", &|_| true).unwrap_err(),
            error(2, "缺少右括号")
        );
        assert_eq!(
            parse_formula("p ∧", &|_| true).unwrap_err(),
            error(3, "这里需要一个表达式")
        );
        assert!(parse_formula("∀ fun : Nat, True", &|_| true).is_err());
        assert!(parse_formula("∀ x : Nat, P x", &|name| name == "P").is_ok());
        assert!(parse_formula("(∀ x : Nat, P x) ∧ Q x", &|n| n == "P" || n == "Q").is_err());
    }

    #[test]
    fn formula_precedence_and_associativity() {
        for (src, lean) in [
            ("a + b ≤ c", "((a + b) ≤ c)"),
            ("p -> q -> r", "(p → (q → r))"),
            ("p \\/ q /\\ r", "(p ∨ (q ∧ r))"),
            ("p ∧ q ∧ r", "(p ∧ (q ∧ r))"),
            ("a - b - c", "((a - b) - c)"),
            ("a / b * c", "((a / b) * c)"),
            ("a ^ b ^ c", "(a ^ (b ^ c))"),
            ("-a ^ b", "(-(a ^ b))"),
            ("¬a = b ∧ p", "((¬(a = b)) ∧ p)"),
            ("f a b + c", "(((f a) b) + c)"),
            ("∀ x : Nat, P x → q", "(∀ (x : Nat), ((P x) → q))"),
            ("∃ x, P x", "(∃ x, (P x))"),
            ("(a : ℕ) != b", "((a : Nat) ≠ b)"),
            ("(p ↔ q) ↔ r", "((p ↔ q) ↔ r)"),
            ("(a < b) = p", "((a < b) = p)"),
        ] {
            assert_eq!(strict(src).to_lean(), lean, "{src}");
        }
    }

    #[test]
    fn formula_latex_snapshots() {
        for (src, latex) in [
            (
                "∀ x y : Nat, P x y",
                r"\forall x\, y \in \mathbb{N},\ P(x, y)",
            ),
            (
                "∃ x : Int, x ≤ a ∧ x ≠ b",
                r"\exists x \in \mathbb{Z},\ x \le a \land x \neq b",
            ),
            (
                "p ∨ q → ¬p ↔ q",
                r"p \lor q \Rightarrow \neg p \Leftrightarrow q",
            ),
            ("(p → q) ∧ r", r"\left(p \Rightarrow q\right) \land r"),
            ("a - (b - c)", r"a - \left(b - c\right)"),
            ("(a + b) * c % 2", r"\left(a + b\right) \cdot c \bmod 2"),
            ("a ^ b ^ c", r"{a}^{{b}^{c}}"),
            ("(a ^ b) ^ c", r"{\left({a}^{b}\right)}^{c}"),
            ("a | b", r"a \mid b"),
            (
                "α1 + h₁ + long_name",
                r"\alpha_{1} + h_{1} + \mathrm{long\_name}",
            ),
            ("True ∧ False", r"\top \land \bot"),
            (
                "Nat → Int → Prop",
                r"\mathbb{N} \Rightarrow \mathbb{Z} \Rightarrow \mathrm{Prop}",
            ),
            (
                "∀ f : Nat → Prop, f 0",
                r"\forall f \in \mathbb{N} \to \mathrm{Prop},\ f(0)",
            ),
            ("(a : Nat)", r"\left(a : \mathbb{N}\right)"),
            ("x1' = x_2", r"x_{1}^{\prime} = x_{2}"),
        ] {
            assert_eq!(strict(src).to_latex(), latex, "{src}");
        }
        assert_eq!(
            strict("Nat → Int → Prop").to_latex_type(),
            r"\mathbb{N} \to \mathbb{Z} \to \mathrm{Prop}"
        );
        assert_eq!(
            display_latex("Nat.succ k").unwrap(),
            r"\operatorname{succ}(k)"
        );
        for hole in ["?_", "?m.12", "sorry"] {
            assert_eq!(display_latex(hole).unwrap(), r"\square");
        }
        assert_eq!(display_latex("↑a ≤ ↑b").unwrap(), r"a \le b");
    }

    #[test]
    fn formula_display_accepts_lean_output() {
        for src in [
            "q ∧ p",
            "p ∨ q → q ∨ p",
            "∃ c, a + c = b ∧ c ≤ 5",
            "a + (b - a) = b ∧ b - a ≤ 5",
            "∀ (n : Nat), 0 + n = n",
            "0 + (k + 1) = k + 1",
            "q ∧ sorry",
            "b ≤ ?_",
            "Nat",
            "Prop",
            "∀ (a b : Nat), a ≤ b → a < b + 1",
            "¬p",
            "p ↔ q",
            "a ≠ b",
            "↑a ≤ ↑b",
            "Nat.succ k",
            "p ∧ q → p",
            "True",
            "False",
            "∀ (a b : Nat) (c : Int), a = b",
        ] {
            let latex = display_latex(src).unwrap_or_else(|| panic!("cannot display {src}"));
            assert_eq!(
                latex.matches('{').count(),
                latex.matches('}').count(),
                "{latex}"
            );
        }
        for src in [
            "",
            "fun x => x",
            "⟨p, q⟩",
            "p ∧",
            "((",
            "?m.",
            "Nat..succ",
            "\"str\"",
        ] {
            assert!(parse_display(src).is_none(), "accepted {src}");
        }
    }

    #[test]
    fn formula_name_rules() {
        for name in ["x", "abc", "a_B2'", "α", "ω1", "ς", "h₀₁", "x_1", "VsH0"] {
            assert!(is_valid_name(name), "{name}");
        }
        assert!(is_valid_name(&"a".repeat(32)));
        for name in [
            "", "_x", "1x", "λ", "αβ", "中", "x.y", "x-y", "x y", "vs", "vsH0", "VSx",
        ] {
            assert!(!is_valid_name(name), "{name}");
        }
        for name in RESERVED {
            assert!(!is_valid_name(name), "{name}");
        }
        assert!(!is_valid_name(&"a".repeat(33)));
    }

    #[test]
    fn formula_free_names_respect_binder_scope() {
        let formula = strict("(∀ x : Nat, P x y) ∧ Q x");
        assert_eq!(
            formula.free_names(),
            ["P", "Q", "x", "y"].map(str::to_string).into()
        );
        assert_eq!(
            strict("∀ x : Nat, ∃ x : Int, P x a").free_names(),
            ["P", "a"].map(str::to_string).into()
        );
        assert_eq!(
            strict("∀ (x : T) (y : F x), R x y").free_names(),
            ["F", "R", "T"].map(str::to_string).into()
        );
        assert_eq!(
            strict("∀ x : x, x = x").free_names(),
            ["x"].map(str::to_string).into()
        );
        assert!(strict("∀ x : Nat, x = x").free_names().is_empty());
    }

    #[test]
    fn formula_limits_and_unicode_offsets() {
        assert!(
            parse_formula(&"p".repeat(crate::graph::MAX_FORMULA_CHARS + 1), &|_| true).is_err()
        );
        let too_deep = format!("{}p{}", "(".repeat(70), ")".repeat(70));
        assert!(parse_formula(&too_deep, &|_| true).is_err());
        assert!(parse_display(&too_deep).is_none());
        assert!(parse_display(&vec!["p"; 100].join(" + ")).is_none());
        assert!(parse_display(&" ".repeat(MAX_DISPLAY_CHARS + 1)).is_none());
        assert_eq!(parse_formula("α ∧ ?_", &|_| true).unwrap_err().offset, 4);
    }

    #[test]
    fn formula_emitted_lean_elaborates_with_real_lean() {
        use std::{
            process::{Command, Stdio},
            time::{Duration, Instant},
        };
        let Some(home) = std::env::var_os("USERPROFILE") else {
            eprintln!("Skipping real Lean test: USERPROFILE is not set");
            return;
        };
        let lean = std::path::PathBuf::from(home)
            .join(".elan/toolchains/leanprover--lean4---v4.35.0/bin/lean.exe");
        if !lean.is_file() {
            eprintln!("Skipping real Lean test: {} does not exist", lean.display());
            return;
        }
        let dir = std::env::temp_dir().join(format!(
            "vectspace-formula-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("Formula.lean");
        let output_file = dir.join("output.json");
        let cases = [
            "p ∧ q → q ∨ p",
            "¬p ↔ q",
            "a + b ≤ b * 2",
            "a != b",
            "a | b",
            "a / (b + 1) % 2 = 0",
            "(a : ℕ) = b",
            "True ∧ False",
            "∀ x y : Nat, P x → x + y = y + x",
            "∃ x, P x ∧ x ≤ a",
            "∀ (x y : Nat) (z : Int), x ≤ y → z = z",
        ];
        let mut source = String::from(
            "set_option autoImplicit false\nset_option linter.unusedVariables false\n",
        );
        for src in cases {
            source.push_str(&format!(
                "example (p q : Prop) (a b : Nat) (P : Nat → Prop) : Prop := {}\n",
                strict(src).to_lean()
            ));
        }
        source.push_str(&format!(
            "example (a b : Int) : Prop := {}\n",
            strict("-a ^ 2 = b").to_lean()
        ));
        source.push_str(&format!(
            "example : Type := {}\n",
            strict("Nat → Int → Prop").to_lean()
        ));
        std::fs::write(&file, source).unwrap();
        let stdout = std::fs::File::create(&output_file).unwrap();
        let mut child = Command::new(lean)
            .arg("--json")
            .arg(&file)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let start = Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            if start.elapsed() > Duration::from_secs(30) {
                child.kill().unwrap();
                let _ = child.wait();
                panic!(
                    "Lean did not finish within 30 seconds; input: {}",
                    file.display()
                );
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let result = child.wait_with_output().unwrap();
        let output = std::fs::read_to_string(&output_file).unwrap();
        let has_error = output.lines().any(|line| {
            serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .is_some_and(|message| message["severity"] == "error")
        });
        assert!(
            result.status.success() && !has_error,
            "Lean rejected formulas in {}:\n{output}\n{}",
            file.display(),
            String::from_utf8_lossy(&result.stderr)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
